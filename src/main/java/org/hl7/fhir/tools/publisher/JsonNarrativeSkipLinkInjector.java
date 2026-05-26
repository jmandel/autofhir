package org.hl7.fhir.tools.publisher;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

public class JsonNarrativeSkipLinkInjector {

  private static final String EXAMPLE_DIV = "<div class=\"example\">";
  private static final String JSON_PRE_START = "<pre class=\"json\"";
  private static final String PRE_END = "</pre>";
  private static final String SKIP_LINK = "<p><a href=\"#DomainResource.text.div-end\">Jump past Narrative</a></p>";
  private static final String NARRATIVE_END_ANCHOR = "<a id=\"DomainResource.text.div-end\"></a>";
  private static final Pattern TOP_LEVEL_TEXT = Pattern.compile("^  &quot;text&quot;\\s*:\\s*\\{\\s*$");
  private static final Pattern TOP_LEVEL_TEXT_END = Pattern.compile("^  \\}\\s*,?\\s*$");
  private static final Pattern NARRATIVE_DIV = Pattern.compile("^    &quot;div&quot;\\s*:\\s*&quot;.*$");

  public static void main(String[] args) throws IOException {
    Path publishDir = args.length == 0 ? Path.of("publish") : Path.of(args[0]);
    addJsonNarrativeSkipLinks(publishDir);
  }

  public static void addJsonNarrativeSkipLinks(Path publishDir) throws IOException {
    if (!Files.exists(publishDir)) {
      System.out.println("No publish directory found at " + publishDir + "; skipping JSON narrative skip links.");
      return;
    }

    int changed = processDirectoryResources(publishDir);
    System.out.println("Added JSON narrative skip links to " + changed + " published artifact(s).");
  }

  private static int processDirectoryResources(Path root) throws IOException {
    List<Path> candidates;
    try (Stream<Path> stream = Files.walk(root)) {
      candidates = stream
          .filter(Files::isRegularFile)
          .filter(path -> path.getFileName().toString().endsWith(".json.html"))
          .toList();
    }

    int changed = 0;
    for (Path candidate : candidates) {
      String content = Files.readString(candidate, StandardCharsets.UTF_8);
      String fixed = addJsonNarrativeSkipLink(content);
      if (!fixed.equals(content)) {
        Files.writeString(candidate, fixed, StandardCharsets.UTF_8);
        changed++;
      }
    }
    return changed;
  }

  private static String addJsonNarrativeSkipLink(String content) {
    if (content.contains("Jump past Narrative")) {
      return content;
    }

    int exampleDivStart = content.indexOf(EXAMPLE_DIV);
    if (exampleDivStart < 0) {
      return content;
    }

    int narrativeDivEnd = findTopLevelNarrativeDivLineEnd(content, exampleDivStart);
    if (narrativeDivEnd < 0) {
      return content;
    }

    String lineEnding = content.contains("\r\n") ? "\r\n" : "\n";
    String fixed = content.contains(NARRATIVE_END_ANCHOR)
        ? content
        : content.substring(0, narrativeDivEnd) + NARRATIVE_END_ANCHOR + content.substring(narrativeDivEnd);

    int insertAt = fixed.indexOf(EXAMPLE_DIV);
    return fixed.substring(0, insertAt) + SKIP_LINK + lineEnding + fixed.substring(insertAt);
  }

  private static int findTopLevelNarrativeDivLineEnd(String content, int searchStart) {
    int preStart = content.indexOf(JSON_PRE_START, searchStart);
    if (preStart < 0) {
      return -1;
    }

    int preEnd = content.indexOf(PRE_END, preStart);
    if (preEnd < 0) {
      return -1;
    }
    int preContentStart = content.indexOf('>', preStart);
    if (preContentStart < 0 || preContentStart > preEnd) {
      return -1;
    }

    boolean inTopLevelText = false;
    int lineStart = preContentStart + 1;
    while (lineStart < preEnd) {
      int lineEnd = lineEnd(content, lineStart, preEnd);
      String line = content.substring(lineStart, lineEnd);

      if (!inTopLevelText && TOP_LEVEL_TEXT.matcher(line).matches()) {
        inTopLevelText = true;
      } else if (inTopLevelText && NARRATIVE_DIV.matcher(line).matches()) {
        return lineEnd;
      } else if (inTopLevelText && TOP_LEVEL_TEXT_END.matcher(line).matches()) {
        return -1;
      }

      lineStart = nextLineStart(content, lineEnd);
    }
    return -1;
  }

  private static int lineEnd(String content, int lineStart, int limit) {
    int newline = content.indexOf('\n', lineStart);
    if (newline < 0 || newline > limit) {
      return limit;
    }
    return newline > lineStart && content.charAt(newline - 1) == '\r' ? newline - 1 : newline;
  }

  private static int nextLineStart(String content, int lineEnd) {
    if (lineEnd < content.length() && content.charAt(lineEnd) == '\r') {
      lineEnd++;
    }
    if (lineEnd < content.length() && content.charAt(lineEnd) == '\n') {
      lineEnd++;
    }
    return lineEnd;
  }
}
