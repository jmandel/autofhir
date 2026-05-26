package org.hl7.fhir.tools.publisher;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

public class ProfileDefinitionAnchorAliasInjector {

  private static final String DEFINITIONS_SUFFIX = "-definitions.html";
  private static final Pattern ANCHOR = Pattern.compile("<a\\s+name=\"([^\"]+)\">\\s*</a>");
  private static final Pattern TARGET_ATTRIBUTE = Pattern.compile("\\s(?:id|name)=\"([^\"]+)\"");
  private static final Pattern CHOICE_SLICE =
      Pattern.compile("(^|\\.)([A-Za-z][A-Za-z0-9]*)\\[x\\]:([A-Za-z][A-Za-z0-9]*)(?=\\.|$)");

  public static void main(String[] args) throws IOException {
    Path publishDir = args.length == 0 ? Path.of("publish") : Path.of(args[0]);
    addProfileDefinitionAnchorAliases(publishDir);
  }

  public static void addProfileDefinitionAnchorAliases(Path publishDir) throws IOException {
    if (!Files.exists(publishDir)) {
      System.out.println(
          "No publish directory found at " + publishDir + "; skipping profile definition anchor aliases.");
      return;
    }

    int changed = processDirectoryResources(publishDir);
    System.out.println("Added profile definition anchor aliases to " + changed + " published artifact(s).");
  }

  private static int processDirectoryResources(Path root) throws IOException {
    List<Path> candidates;
    try (Stream<Path> stream = Files.walk(root)) {
      candidates = stream
          .filter(Files::isRegularFile)
          .filter(path -> path.getFileName().toString().endsWith(DEFINITIONS_SUFFIX))
          .toList();
    }

    int changed = 0;
    for (Path candidate : candidates) {
      String content = Files.readString(candidate, StandardCharsets.UTF_8);
      String fixed = addProfileDefinitionAnchorAliases(
          candidate.getFileName().toString(),
          content,
          collectRequestedFragments(candidate));
      if (!fixed.equals(content)) {
        Files.writeString(candidate, fixed, StandardCharsets.UTF_8);
        changed++;
      }
    }
    return changed;
  }

  static String addProfileDefinitionAnchorAliases(String fileName, String content) {
    return addProfileDefinitionAnchorAliases(fileName, content, Set.of());
  }

  static String addProfileDefinitionAnchorAliases(String fileName, String content, Set<String> requestedFragments) {
    if (!fileName.endsWith(DEFINITIONS_SUFFIX)) {
      return content;
    }

    String prefix = fileName.substring(0, fileName.length() - DEFINITIONS_SUFFIX.length()) + ".";
    if (!content.contains("name=\"" + prefix)) {
      return content;
    }

    Set<String> targets = collectTargets(content);
    Map<String, List<String>> aliasesByTarget = buildAliasesByTarget(prefix, targets, requestedFragments);
    if (aliasesByTarget.isEmpty()) {
      return content;
    }

    Matcher matcher = ANCHOR.matcher(content);
    StringBuffer result = new StringBuffer();
    boolean changed = false;
    while (matcher.find()) {
      String target = matcher.group(1);
      List<String> aliases = aliasesByTarget.get(target);
      if (aliases != null) {
        StringBuilder replacement = new StringBuilder();
        for (String alias : aliases) {
          replacement.append("<a name=\"").append(alias).append("\"> </a>");
        }
        replacement.append(matcher.group());
        matcher.appendReplacement(result, Matcher.quoteReplacement(replacement.toString()));
        changed = true;
        continue;
      }
      matcher.appendReplacement(result, Matcher.quoteReplacement(matcher.group()));
    }
    matcher.appendTail(result);
    return changed ? result.toString() : content;
  }

  private static Set<String> collectRequestedFragments(Path definitionsFile) throws IOException {
    String definitionsName = definitionsFile.getFileName().toString();
    String stem = definitionsName.substring(0, definitionsName.length() - DEFINITIONS_SUFFIX.length());
    Path profilePage = definitionsFile.resolveSibling(stem + ".html");
    if (!Files.exists(profilePage)) {
      return Set.of();
    }

    String content = Files.readString(profilePage, StandardCharsets.UTF_8);
    Pattern link = Pattern.compile("href=\"" + Pattern.quote(definitionsName) + "#([^\"]+)\"");
    Matcher matcher = link.matcher(content);
    Set<String> fragments = new HashSet<>();
    while (matcher.find()) {
      fragments.add(matcher.group(1));
    }
    return fragments;
  }

  private static Map<String, List<String>> buildAliasesByTarget(
      String prefix,
      Set<String> targets,
      Set<String> requestedFragments) {
    Map<String, AliasMatch> aliases = new HashMap<>();
    boolean hasRequestedFragments = requestedFragments != null && !requestedFragments.isEmpty();

    for (String target : targets) {
      String elementId = target.startsWith(prefix) ? target.substring(prefix.length()) : target;
      if (!isElementDefinitionAlias(elementId)) {
        continue;
      }

      if (!hasRequestedFragments) {
        if (target.startsWith(prefix) && !targets.contains(elementId)) {
          putAlias(aliases, elementId, target, 3);
        }
        continue;
      }

      for (String requestedFragment : requestedFragments) {
        if (targets.contains(requestedFragment) || !isElementDefinitionAlias(requestedFragment)) {
          continue;
        }
        int score = matchScore(requestedFragment, elementId);
        if (score > 0) {
          putAlias(aliases, requestedFragment, target, score);
        }
      }
    }

    Map<String, List<String>> aliasesByTarget = new HashMap<>();
    for (Map.Entry<String, AliasMatch> alias : aliases.entrySet()) {
      aliasesByTarget.computeIfAbsent(alias.getValue().target, key -> new ArrayList<>()).add(alias.getKey());
    }
    for (List<String> targetAliases : aliasesByTarget.values()) {
      Collections.sort(targetAliases);
    }
    return aliasesByTarget;
  }

  private static void putAlias(Map<String, AliasMatch> aliases, String alias, String target, int score) {
    AliasMatch existing = aliases.get(alias);
    if (existing == null
        || score > existing.score
        || (score == existing.score && target.compareTo(existing.target) < 0)) {
      aliases.put(alias, new AliasMatch(target, score));
    }
  }

  private static int matchScore(String requestedFragment, String elementId) {
    if (requestedFragment.equals(elementId)) {
      return 3;
    }

    String choiceSliceAlias = choiceSliceAlias(elementId);
    if (!choiceSliceAlias.equals(elementId) && requestedFragment.equals(choiceSliceAlias)) {
      return 2;
    }

    return choiceBaseMatches(requestedFragment, elementId) ? 1 : 0;
  }

  private static String choiceSliceAlias(String elementId) {
    Matcher matcher = CHOICE_SLICE.matcher(elementId);
    StringBuffer alias = new StringBuffer();
    boolean changed = false;
    while (matcher.find()) {
      String separator = matcher.group(1);
      String choiceName = matcher.group(2);
      String sliceName = matcher.group(3);
      if (sliceName.startsWith(choiceName)
          && sliceName.length() > choiceName.length()
          && Character.isUpperCase(sliceName.charAt(choiceName.length()))) {
        matcher.appendReplacement(alias, Matcher.quoteReplacement(separator + sliceName));
        changed = true;
      }
    }
    matcher.appendTail(alias);
    return changed ? alias.toString() : elementId;
  }

  private static boolean choiceBaseMatches(String requestedFragment, String elementId) {
    String[] requestedParts = requestedFragment.split("\\.");
    String[] elementParts = elementId.split("\\.");
    if (requestedParts.length != elementParts.length) {
      return false;
    }

    boolean matchedChoice = false;
    for (int i = 0; i < requestedParts.length; i++) {
      if (requestedParts[i].equals(elementParts[i])) {
        continue;
      }
      if (!elementParts[i].endsWith("[x]")) {
        return false;
      }
      String choiceName = elementParts[i].substring(0, elementParts[i].length() - 3);
      if (!requestedParts[i].startsWith(choiceName)
          || requestedParts[i].length() == choiceName.length()
          || !Character.isUpperCase(requestedParts[i].charAt(choiceName.length()))) {
        return false;
      }
      matchedChoice = true;
    }
    return matchedChoice;
  }

  private static Set<String> collectTargets(String content) {
    Set<String> targets = new HashSet<>();
    Matcher matcher = TARGET_ATTRIBUTE.matcher(content);
    while (matcher.find()) {
      targets.add(matcher.group(1));
    }
    return targets;
  }

  private static boolean isElementDefinitionAlias(String alias) {
    return !alias.isEmpty() && Character.isUpperCase(alias.charAt(0));
  }

  private record AliasMatch(String target, int score) {
  }
}
