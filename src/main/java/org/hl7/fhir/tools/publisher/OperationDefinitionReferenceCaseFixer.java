package org.hl7.fhir.tools.publisher;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public class OperationDefinitionReferenceCaseFixer {

  private static final String OPERATION_DEFINITION_PREFIX = "http://hl7.org/fhir/OperationDefinition/";
  private static final String BUILD_OPERATION_DEFINITION_PREFIX = "http://hl7.org/fhir/build/OperationDefinition/";
  private static final Pattern OPERATION_DEFINITION_CANONICAL =
      Pattern.compile("http://hl7\\.org/fhir/(?:build/)?OperationDefinition/[A-Za-z][A-Za-z0-9.-]*");
  private static final Pattern XML_OPERATION_DEFINITION =
      Pattern.compile("<OperationDefinition\\b.*?<url\\s+value=\"([^\"]+)\"", Pattern.DOTALL);

  public static void main(String[] args) throws IOException {
    Path publishDir = args.length == 0 ? Path.of("publish") : Path.of(args[0]);
    fixOperationDefinitionReferenceCasing(publishDir);
  }

  public static void fixOperationDefinitionReferenceCasing(Path publishDir) throws IOException {
    if (!Files.exists(publishDir)) {
      System.out.println("No publish directory found at " + publishDir + "; skipping OperationDefinition reference case correction.");
      return;
    }

    int changed = processDirectoryResources(publishDir) + processArchives(publishDir);
    System.out.println("Corrected OperationDefinition reference casing in " + changed + " published artifact(s).");
  }

  private static int processDirectoryResources(Path root) throws IOException {
    List<Path> candidates;
    try (Stream<Path> stream = Files.walk(root)) {
      candidates = stream
          .filter(Files::isRegularFile)
          .filter(path -> isTextResource(path.getFileName().toString()))
          .toList();
    }

    Map<String, String> operationDefinitions = new HashMap<>();
    for (Path candidate : candidates) {
      String content = Files.readString(candidate, StandardCharsets.UTF_8);
      collectOperationDefinitionUrls(candidate.getFileName().toString(), content, operationDefinitions);
    }

    if (operationDefinitions.isEmpty()) {
      return 0;
    }

    int changed = 0;
    for (Path candidate : candidates) {
      String content = Files.readString(candidate, StandardCharsets.UTF_8);
      if (!containsCapabilityStatement(content)) {
        continue;
      }
      String fixed = fixOperationDefinitionCanonicalCase(content, operationDefinitions);
      if (!fixed.equals(content)) {
        Files.writeString(candidate, fixed, StandardCharsets.UTF_8);
        changed++;
      }
    }
    return changed;
  }

  private static int processArchives(Path root) throws IOException {
    List<Path> archives;
    try (Stream<Path> stream = Files.walk(root)) {
      archives = stream
          .filter(Files::isRegularFile)
          .filter(path -> isArchive(path.getFileName().toString()))
          .toList();
    }

    int changed = 0;
    for (Path archive : archives) {
      if (processArchive(archive)) {
        changed++;
      }
    }
    return changed;
  }

  private static boolean processArchive(Path archive) throws IOException {
    String name = archive.getFileName().toString().toLowerCase(Locale.ROOT);
    if (name.endsWith(".zip")) {
      return processZip(archive);
    }
    if (name.endsWith(".tgz") || name.endsWith(".tar.gz")) {
      return processTarGz(archive);
    }
    return false;
  }

  private static boolean processZip(Path archive) throws IOException {
    List<ArchiveEntry> entries = readZip(archive);
    if (!fixArchiveEntries(entries)) {
      return false;
    }

    Path tmp = Files.createTempFile(archive.getParent(), archive.getFileName().toString(), ".tmp");
    try {
      writeZip(tmp, entries);
      Files.move(tmp, archive, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(tmp);
    }
    return true;
  }

  private static boolean processTarGz(Path archive) throws IOException {
    List<TarEntryData> entries = readTarGz(archive);
    List<ArchiveEntry> archiveEntries = new ArrayList<>();
    for (TarEntryData entry : entries) {
      archiveEntries.add(new ArchiveEntry(entry.name, entry.directory, entry.data));
    }

    if (!fixArchiveEntries(archiveEntries)) {
      return false;
    }

    for (int i = 0; i < entries.size(); i++) {
      entries.get(i).data = archiveEntries.get(i).data;
    }

    Path tmp = Files.createTempFile(archive.getParent(), archive.getFileName().toString(), ".tmp");
    try {
      writeTarGz(tmp, entries);
      Files.move(tmp, archive, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(tmp);
    }
    return true;
  }

  private static boolean fixArchiveEntries(List<ArchiveEntry> entries) throws IOException {
    Map<String, String> operationDefinitions = new HashMap<>();
    for (ArchiveEntry entry : entries) {
      if (!entry.directory && isTextResource(entry.name)) {
        collectOperationDefinitionUrls(entry.name, new String(entry.data, StandardCharsets.UTF_8), operationDefinitions);
      }
    }

    if (operationDefinitions.isEmpty()) {
      return false;
    }

    boolean changed = false;
    for (ArchiveEntry entry : entries) {
      if (entry.directory || !isTextResource(entry.name)) {
        continue;
      }
      String content = new String(entry.data, StandardCharsets.UTF_8);
      if (!containsCapabilityStatement(content)) {
        continue;
      }
      String fixed = fixOperationDefinitionCanonicalCase(content, operationDefinitions);
      if (!fixed.equals(content)) {
        entry.data = fixed.getBytes(StandardCharsets.UTF_8);
        changed = true;
      }
    }
    return changed;
  }

  private static void collectOperationDefinitionUrls(String name, String content, Map<String, String> operationDefinitions) throws IOException {
    if (!content.contains("OperationDefinition")) {
      return;
    }

    if (name.toLowerCase(Locale.ROOT).endsWith(".json")) {
      try {
        collectOperationDefinitionUrls(JsonParser.parseString(content), operationDefinitions);
      } catch (RuntimeException e) {
        throw new IOException("Unable to parse JSON while fixing OperationDefinition references in " + name, e);
      }
    } else if (name.toLowerCase(Locale.ROOT).endsWith(".xml")) {
      Matcher matcher = XML_OPERATION_DEFINITION.matcher(content);
      while (matcher.find()) {
        addOperationDefinitionUrl(operationDefinitions, matcher.group(1));
      }
    }
  }

  private static void collectOperationDefinitionUrls(JsonElement element, Map<String, String> operationDefinitions) {
    if (element == null || element.isJsonNull()) {
      return;
    }
    if (element.isJsonObject()) {
      JsonObject object = element.getAsJsonObject();
      if ("OperationDefinition".equals(getString(object, "resourceType"))) {
        addOperationDefinitionUrl(operationDefinitions, getString(object, "url"));
      }
      for (Map.Entry<String, JsonElement> property : object.entrySet()) {
        collectOperationDefinitionUrls(property.getValue(), operationDefinitions);
      }
    } else if (element.isJsonArray()) {
      for (JsonElement child : element.getAsJsonArray()) {
        collectOperationDefinitionUrls(child, operationDefinitions);
      }
    }
  }

  private static String getString(JsonObject object, String propertyName) {
    JsonElement property = object.get(propertyName);
    return property == null || !property.isJsonPrimitive() ? null : property.getAsString();
  }

  private static void addOperationDefinitionUrl(Map<String, String> operationDefinitions, String url) {
    if (url == null) {
      return;
    }
    if (url.startsWith(BUILD_OPERATION_DEFINITION_PREFIX)) {
      url = OPERATION_DEFINITION_PREFIX + url.substring(BUILD_OPERATION_DEFINITION_PREFIX.length());
    }
    if (url.startsWith(OPERATION_DEFINITION_PREFIX)) {
      operationDefinitions.put(url.toLowerCase(Locale.ROOT), url);
    }
  }

  private static String fixOperationDefinitionCanonicalCase(String content, Map<String, String> operationDefinitions) {
    Matcher matcher = OPERATION_DEFINITION_CANONICAL.matcher(content);
    StringBuffer result = new StringBuffer();
    boolean changed = false;
    while (matcher.find()) {
      String found = matcher.group();
      String lookup = found.startsWith(BUILD_OPERATION_DEFINITION_PREFIX)
          ? OPERATION_DEFINITION_PREFIX + found.substring(BUILD_OPERATION_DEFINITION_PREFIX.length())
          : found;
      String fixed = operationDefinitions.get(lookup.toLowerCase(Locale.ROOT));
      if (fixed != null && !fixed.equals(lookup)) {
        String replacement = found.startsWith(BUILD_OPERATION_DEFINITION_PREFIX)
            ? BUILD_OPERATION_DEFINITION_PREFIX + fixed.substring(OPERATION_DEFINITION_PREFIX.length())
            : fixed;
        matcher.appendReplacement(result, Matcher.quoteReplacement(replacement));
        changed = true;
      }
    }
    matcher.appendTail(result);
    return changed ? result.toString() : content;
  }

  private static boolean containsCapabilityStatement(String content) {
    return content.contains("CapabilityStatement") || content.contains("Conformance");
  }

  private static boolean isTextResource(String name) {
    String lowerName = name.toLowerCase(Locale.ROOT);
    return lowerName.endsWith(".json") || lowerName.endsWith(".xml");
  }

  private static boolean isArchive(String name) {
    String lowerName = name.toLowerCase(Locale.ROOT);
    return lowerName.endsWith(".zip") || lowerName.endsWith(".tgz") || lowerName.endsWith(".tar.gz");
  }

  private static List<ArchiveEntry> readZip(Path archive) throws IOException {
    List<ArchiveEntry> entries = new ArrayList<>();
    try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(archive))) {
      ZipEntry entry;
      while ((entry = zip.getNextEntry()) != null) {
        ArchiveEntry archiveEntry = new ArchiveEntry(entry.getName(), entry.isDirectory(), readAllBytes(zip));
        archiveEntry.time = entry.getTime();
        entries.add(archiveEntry);
      }
    }
    return entries;
  }

  private static void writeZip(Path archive, List<ArchiveEntry> entries) throws IOException {
    try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
      for (ArchiveEntry entry : entries) {
        ZipEntry zipEntry = new ZipEntry(entry.directory && !entry.name.endsWith("/") ? entry.name + "/" : entry.name);
        if (entry.time >= 0) {
          zipEntry.setTime(entry.time);
        }
        zip.putNextEntry(zipEntry);
        if (!entry.directory) {
          zip.write(entry.data);
        }
        zip.closeEntry();
      }
    }
  }

  private static List<TarEntryData> readTarGz(Path archive) throws IOException {
    List<TarEntryData> entries = new ArrayList<>();
    try (InputStream input = new GZIPInputStream(Files.newInputStream(archive))) {
      while (true) {
        byte[] header = input.readNBytes(512);
        if (header.length == 0) {
          break;
        }
        if (header.length != 512) {
          throw new IOException("Incomplete tar header in " + archive);
        }
        if (isZeroBlock(header)) {
          break;
        }

        long size = parseOctal(header, 124, 12);
        if (size > Integer.MAX_VALUE) {
          throw new IOException("Tar entry too large to process in " + archive + ": " + readTarString(header, 0, 100));
        }

        TarEntryData entry = new TarEntryData();
        String name = readTarString(header, 0, 100);
        String prefix = readTarString(header, 345, 155);
        entry.name = prefix.isEmpty() ? name : prefix + "/" + name;
        entry.mode = parseOctal(header, 100, 8);
        entry.uid = parseOctal(header, 108, 8);
        entry.gid = parseOctal(header, 116, 8);
        entry.mtime = parseOctal(header, 136, 12);
        entry.typeFlag = header[156] == 0 ? (byte) '0' : header[156];
        entry.linkName = readTarString(header, 157, 100);
        entry.directory = entry.typeFlag == '5';
        entry.data = input.readNBytes((int) size);
        if (entry.data.length != size) {
          throw new IOException("Incomplete tar entry data in " + archive + ": " + entry.name);
        }
        skipFully(input, padding(size));
        entries.add(entry);
      }
    }
    return entries;
  }

  private static void writeTarGz(Path archive, List<TarEntryData> entries) throws IOException {
    try (OutputStream output = new GZIPOutputStream(Files.newOutputStream(archive))) {
      for (TarEntryData entry : entries) {
        byte[] data = entry.directory ? new byte[0] : entry.data;
        byte[] header = createTarHeader(entry, data.length);
        output.write(header);
        output.write(data);
        writePadding(output, padding(data.length));
      }
      output.write(new byte[1024]);
    }
  }

  private static byte[] createTarHeader(TarEntryData entry, long size) throws IOException {
    byte[] header = new byte[512];
    TarName tarName = splitTarName(entry.name);
    writeTarString(header, 0, 100, tarName.name);
    writeOctal(header, 100, 8, entry.mode == 0 ? 0644 : entry.mode);
    writeOctal(header, 108, 8, entry.uid);
    writeOctal(header, 116, 8, entry.gid);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, entry.mtime);
    for (int i = 148; i < 156; i++) {
      header[i] = (byte) ' ';
    }
    header[156] = entry.typeFlag == 0 ? (entry.directory ? (byte) '5' : (byte) '0') : entry.typeFlag;
    writeTarString(header, 157, 100, entry.linkName);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    writeTarString(header, 345, 155, tarName.prefix);

    long checksum = 0;
    for (byte b : header) {
      checksum += b & 0xff;
    }
    String checksumValue = String.format(Locale.ROOT, "%06o", checksum);
    writeTarString(header, 148, 6, checksumValue);
    header[154] = 0;
    header[155] = (byte) ' ';
    return header;
  }

  private static TarName splitTarName(String name) throws IOException {
    byte[] nameBytes = name.getBytes(StandardCharsets.UTF_8);
    if (nameBytes.length <= 100) {
      return new TarName("", name);
    }

    int split = name.lastIndexOf('/');
    while (split > 0) {
      String prefix = name.substring(0, split);
      String suffix = name.substring(split + 1);
      if (prefix.getBytes(StandardCharsets.UTF_8).length <= 155 && suffix.getBytes(StandardCharsets.UTF_8).length <= 100) {
        return new TarName(prefix, suffix);
      }
      split = name.lastIndexOf('/', split - 1);
    }
    throw new IOException("Tar entry name is too long: " + name);
  }

  private static long parseOctal(byte[] source, int offset, int length) {
    long value = 0;
    for (int i = offset; i < offset + length; i++) {
      byte b = source[i];
      if (b == 0 || b == ' ') {
        continue;
      }
      value = (value << 3) + (b - '0');
    }
    return value;
  }

  private static void writeOctal(byte[] target, int offset, int length, long value) {
    String octal = Long.toOctalString(value);
    int end = offset + length - 1;
    target[end] = 0;
    int pos = end - 1;
    for (int i = octal.length() - 1; i >= 0 && pos >= offset; i--) {
      target[pos--] = (byte) octal.charAt(i);
    }
    while (pos >= offset) {
      target[pos--] = (byte) '0';
    }
  }

  private static String readTarString(byte[] source, int offset, int length) {
    int end = offset;
    while (end < offset + length && source[end] != 0) {
      end++;
    }
    return new String(source, offset, end - offset, StandardCharsets.UTF_8);
  }

  private static void writeTarString(byte[] target, int offset, int length, String value) {
    if (value == null) {
      return;
    }
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    System.arraycopy(bytes, 0, target, offset, Math.min(bytes.length, length));
  }

  private static boolean isZeroBlock(byte[] block) {
    for (byte b : block) {
      if (b != 0) {
        return false;
      }
    }
    return true;
  }

  private static int padding(long size) {
    return (int) ((512 - (size % 512)) % 512);
  }

  private static void writePadding(OutputStream output, int padding) throws IOException {
    if (padding > 0) {
      output.write(new byte[padding]);
    }
  }

  private static void skipFully(InputStream input, int length) throws IOException {
    int remaining = length;
    while (remaining > 0) {
      long skipped = input.skip(remaining);
      if (skipped <= 0) {
        if (input.read() == -1) {
          throw new IOException("Unexpected end of tar padding");
        }
        skipped = 1;
      }
      remaining -= skipped;
    }
  }

  private static byte[] readAllBytes(InputStream input) throws IOException {
    ByteArrayOutputStream result = new ByteArrayOutputStream();
    input.transferTo(result);
    return result.toByteArray();
  }

  private static class ArchiveEntry {
    private final String name;
    private final boolean directory;
    private byte[] data;
    private long time = -1;

    private ArchiveEntry(String name, boolean directory, byte[] data) {
      this.name = name;
      this.directory = directory;
      this.data = data;
    }
  }

  private static class TarEntryData {
    private String name;
    private boolean directory;
    private long mode;
    private long uid;
    private long gid;
    private long mtime;
    private byte typeFlag;
    private String linkName;
    private byte[] data;
  }

  private static class TarName {
    private final String prefix;
    private final String name;

    private TarName(String prefix, String name) {
      this.prefix = prefix;
      this.name = name;
    }
  }
}
