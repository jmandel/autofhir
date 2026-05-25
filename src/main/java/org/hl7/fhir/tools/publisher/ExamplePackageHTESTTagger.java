package org.hl7.fhir.tools.publisher;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public class ExamplePackageHTESTTagger {

  private static final String HTEST_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActReason";
  private static final String HTEST_CODE = "HTEST";
  private static final String HTEST_DISPLAY = "test health data";
  private static final Gson PRETTY_GSON = new GsonBuilder().setPrettyPrinting().create();
  private static final Gson COMPACT_GSON = new Gson();

  public static void main(String[] args) throws IOException {
    Path publishDir = args.length == 0 ? Path.of("publish") : Path.of(args[0]);
    tagExamplePackages(publishDir);
  }

  public static void tagExamplePackages(Path publishDir) throws IOException {
    Path examplesZip = publishDir.resolve("examples.zip");
    if (!Files.exists(examplesZip)) {
      System.out.println("No examples.zip found in " + publishDir + "; skipping HTEST package tagging.");
      return;
    }

    Set<String> htestExampleStems = collectHtestExampleStems(examplesZip);
    Set<ResourceKey> taggedResources = new HashSet<>();

    processJsonZip(publishDir.resolve("examples-json.zip"), htestExampleStems, taggedResources);
    processNdjsonZip(publishDir.resolve("examples-ndjson.zip"), taggedResources);
    processTurtleZip(publishDir.resolve("examples-ttl.zip"), htestExampleStems);
  }

  private static Set<String> collectHtestExampleStems(Path zipPath) throws IOException {
    Set<String> stems = new HashSet<>();
    try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(zipPath))) {
      ZipEntry entry;
      while ((entry = zip.getNextEntry()) != null) {
        if (!entry.isDirectory() && entry.getName().endsWith(".xml")) {
          byte[] content = readAllBytes(zip);
          if (new String(content, StandardCharsets.UTF_8).contains(HTEST_CODE)) {
            stems.add(exampleStem(entry.getName(), ".xml"));
          }
        }
      }
    }
    return stems;
  }

  private static void processJsonZip(Path zipPath, Set<String> htestExampleStems, Set<ResourceKey> taggedResources)
      throws IOException {
    if (!Files.exists(zipPath)) {
      return;
    }
    rewriteZip(zipPath, (entryName, content) -> {
      if (!entryName.endsWith(".json")) {
        return content;
      }

      JsonElement element = JsonParser.parseString(new String(content, StandardCharsets.UTF_8));
      if (!element.isJsonObject()) {
        return content;
      }

      JsonObject resource = element.getAsJsonObject();
      boolean hadHtestTag = removeHtestFromMetaTag(resource);
      boolean shouldTag = htestExampleStems.contains(exampleStem(entryName, ".json"))
          || (hadHtestTag && !isBundle(resource));
      boolean changed = hadHtestTag;

      if (shouldTag) {
        changed = ensureHtestSecurity(resource) || changed;
        ResourceKey key = ResourceKey.from(resource);
        if (key != null) {
          taggedResources.add(key);
        }
      } else {
        removeMetaIfEmpty(resource);
      }

      return changed ? (PRETTY_GSON.toJson(resource) + "\n").getBytes(StandardCharsets.UTF_8) : content;
    });
  }

  private static void processNdjsonZip(Path zipPath, Set<ResourceKey> taggedResources) throws IOException {
    if (!Files.exists(zipPath)) {
      return;
    }
    rewriteZip(zipPath, (entryName, content) -> {
      if (!entryName.endsWith(".ndjson")) {
        return content;
      }

      String[] lines = new String(content, StandardCharsets.UTF_8).split("\\R", -1);
      StringBuilder output = new StringBuilder();
      boolean changed = false;
      for (int i = 0; i < lines.length; i++) {
        String line = lines[i];
        if (line.isEmpty() && i == lines.length - 1) {
          continue;
        }
        JsonElement element = JsonParser.parseString(line);
        if (!element.isJsonObject()) {
          output.append(line).append('\n');
          continue;
        }
        JsonObject resource = element.getAsJsonObject();
        boolean lineChanged = removeHtestFromMetaTag(resource);
        if (taggedResources.contains(ResourceKey.from(resource))) {
          lineChanged = ensureHtestSecurity(resource) || lineChanged;
        } else {
          removeMetaIfEmpty(resource);
        }
        output.append(lineChanged ? COMPACT_GSON.toJson(resource) : line).append('\n');
        changed = changed || lineChanged;
      }
      return changed ? output.toString().getBytes(StandardCharsets.UTF_8) : content;
    });
  }

  private static void processTurtleZip(Path zipPath, Set<String> htestExampleStems) throws IOException {
    if (!Files.exists(zipPath)) {
      return;
    }
    rewriteZip(zipPath, (entryName, content) -> {
      if (!entryName.endsWith(".ttl") || !htestExampleStems.contains(exampleStem(entryName, ".ttl"))) {
        return content;
      }
      String ttl = new String(content, StandardCharsets.UTF_8);
      String tagged = ensureTurtleHtestSecurity(ttl);
      return tagged.equals(ttl) ? content : tagged.getBytes(StandardCharsets.UTF_8);
    });
  }

  private static boolean ensureHtestSecurity(JsonObject resource) throws IOException {
    JsonObject meta = forceMeta(resource);
    JsonArray security = forceArray(meta, "security");
    for (JsonElement element : security) {
      if (element.isJsonObject() && isHtestCoding(element.getAsJsonObject())) {
        return false;
      }
    }
    JsonObject coding = new JsonObject();
    coding.addProperty("system", HTEST_SYSTEM);
    coding.addProperty("code", HTEST_CODE);
    coding.addProperty("display", HTEST_DISPLAY);
    security.add(coding);
    return true;
  }

  private static boolean removeHtestFromMetaTag(JsonObject resource) throws IOException {
    JsonElement metaElement = resource.get("meta");
    if (metaElement == null) {
      return false;
    }
    if (!metaElement.isJsonObject()) {
      throw new IOException("Resource meta is not an object");
    }

    JsonObject meta = metaElement.getAsJsonObject();
    JsonElement tagElement = meta.get("tag");
    if (tagElement == null) {
      return false;
    }
    if (!tagElement.isJsonArray()) {
      throw new IOException("Resource meta.tag is not an array");
    }

    JsonArray tags = tagElement.getAsJsonArray();
    JsonArray keptTags = new JsonArray();
    boolean changed = false;
    for (JsonElement tag : tags) {
      if (tag.isJsonObject() && isHtestCoding(tag.getAsJsonObject())) {
        changed = true;
      } else {
        keptTags.add(tag);
      }
    }
    if (changed) {
      if (keptTags.isEmpty()) {
        meta.remove("tag");
      } else {
        meta.add("tag", keptTags);
      }
    }
    return changed;
  }

  private static boolean isHtestCoding(JsonObject coding) {
    JsonElement code = coding.get("code");
    return code != null && code.isJsonPrimitive() && HTEST_CODE.equals(code.getAsString());
  }

  private static boolean isBundle(JsonObject resource) {
    JsonElement resourceType = resource.get("resourceType");
    return resourceType != null && resourceType.isJsonPrimitive() && "Bundle".equals(resourceType.getAsString());
  }

  private static JsonObject forceMeta(JsonObject resource) throws IOException {
    JsonElement metaElement = resource.get("meta");
    if (metaElement == null) {
      JsonObject meta = new JsonObject();
      resource.add("meta", meta);
      return meta;
    }
    if (!metaElement.isJsonObject()) {
      throw new IOException("Resource meta is not an object");
    }
    return metaElement.getAsJsonObject();
  }

  private static JsonArray forceArray(JsonObject object, String name) throws IOException {
    JsonElement element = object.get(name);
    if (element == null) {
      JsonArray array = new JsonArray();
      object.add(name, array);
      return array;
    }
    if (!element.isJsonArray()) {
      throw new IOException("JSON property " + name + " is not an array");
    }
    return element.getAsJsonArray();
  }

  private static void removeMetaIfEmpty(JsonObject resource) {
    JsonElement metaElement = resource.get("meta");
    if (metaElement != null && metaElement.isJsonObject() && metaElement.getAsJsonObject().entrySet().isEmpty()) {
      resource.remove("meta");
    }
  }

  private static String ensureTurtleHtestSecurity(String ttl) throws IOException {
    if (ttl.contains("fhir:v \"HTEST\"")) {
      return ttl;
    }
    if (!ttl.contains("@prefix xsd:")) {
      throw new IOException("FHIR Turtle example is missing the xsd prefix");
    }

    int metaMarker = ttl.indexOf("\n  fhir:meta [\n");
    if (metaMarker >= 0) {
      int insertAt = ttl.indexOf('\n', metaMarker + 1) + 1;
      String nextLine = nextNonEmptyLine(ttl, insertAt);
      String security = turtleSecurityBlock(nextLine.startsWith("  ]"));
      return ttl.substring(0, insertAt) + security + ttl.substring(insertAt);
    }

    int insertAt = endOfLineAfter(ttl, "\n  fhir:id [");
    if (insertAt < 0) {
      insertAt = endOfLineAfter(ttl, "\n  fhir:nodeRole fhir:treeRoot ;");
    }
    if (insertAt < 0) {
      throw new IOException("Unable to find insertion point for FHIR Turtle meta.security");
    }
    return ttl.substring(0, insertAt) + turtleMetaBlock() + ttl.substring(insertAt);
  }

  private static String nextNonEmptyLine(String text, int start) {
    int current = start;
    while (current < text.length()) {
      int end = text.indexOf('\n', current);
      if (end < 0) {
        end = text.length();
      }
      String line = text.substring(current, end).trim();
      if (!line.isEmpty()) {
        return text.substring(current, end);
      }
      current = end + 1;
    }
    return "";
  }

  private static int endOfLineAfter(String text, String marker) {
    int start = text.indexOf(marker);
    if (start < 0) {
      return -1;
    }
    int end = text.indexOf('\n', start + marker.length());
    return end < 0 ? text.length() : end + 1;
  }

  private static String turtleMetaBlock() {
    return "  fhir:meta [\n" + turtleSecurityBlock(true) + "  ] ; # \n";
  }

  private static String turtleSecurityBlock(boolean onlyMetaProperty) {
    return "     fhir:security ( [\n"
        + "       fhir:system [\n"
        + "         fhir:v \"" + HTEST_SYSTEM + "\"^^xsd:anyURI ;\n"
        + "         fhir:l <" + HTEST_SYSTEM + ">\n"
        + "       ] ;\n"
        + "       fhir:code [ fhir:v \"" + HTEST_CODE + "\" ] ;\n"
        + "       fhir:display [ fhir:v \"" + HTEST_DISPLAY + "\" ]\n"
        + "     ] )" + (onlyMetaProperty ? "\n" : " ;\n");
  }

  private static void rewriteZip(Path zipPath, ZipEntryProcessor processor) throws IOException {
    byte[] original = Files.readAllBytes(zipPath);
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    try (ZipInputStream zipIn = new ZipInputStream(new ByteArrayInputStream(original));
        ZipOutputStream zipOut = new ZipOutputStream(output)) {
      ZipEntry entry;
      while ((entry = zipIn.getNextEntry()) != null) {
        byte[] content = entry.isDirectory() ? new byte[0] : readAllBytes(zipIn);
        ZipEntry newEntry = new ZipEntry(entry.getName());
        newEntry.setComment(entry.getComment());
        newEntry.setTime(entry.getTime());
        zipOut.putNextEntry(newEntry);
        if (!entry.isDirectory()) {
          zipOut.write(processor.process(entry.getName(), content));
        }
        zipOut.closeEntry();
      }
    }
    Files.write(zipPath, output.toByteArray());
  }

  private static byte[] readAllBytes(ZipInputStream zip) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    zip.transferTo(bytes);
    return bytes.toByteArray();
  }

  private static String exampleStem(String entryName, String extension) {
    String fileName = entryName.substring(entryName.lastIndexOf('/') + 1);
    String stem = fileName.endsWith(extension) ? fileName.substring(0, fileName.length() - extension.length()) : fileName;
    int idStart = stem.indexOf('(');
    return idStart >= 0 ? stem.substring(0, idStart) : stem;
  }

  private interface ZipEntryProcessor {
    byte[] process(String entryName, byte[] content) throws IOException;
  }

  private static class ResourceKey {
    private final String resourceType;
    private final String id;

    private ResourceKey(String resourceType, String id) {
      this.resourceType = resourceType;
      this.id = id;
    }

    private static ResourceKey from(JsonObject resource) {
      JsonElement resourceType = resource.get("resourceType");
      JsonElement id = resource.get("id");
      if (resourceType == null || id == null || !resourceType.isJsonPrimitive() || !id.isJsonPrimitive()) {
        return null;
      }
      return new ResourceKey(resourceType.getAsString(), id.getAsString());
    }

    @Override
    public boolean equals(Object other) {
      if (!(other instanceof ResourceKey)) {
        return false;
      }
      ResourceKey otherKey = (ResourceKey) other;
      return resourceType.equals(otherKey.resourceType) && id.equals(otherKey.id);
    }

    @Override
    public int hashCode() {
      return 31 * resourceType.hashCode() + id.hashCode();
    }
  }
}
