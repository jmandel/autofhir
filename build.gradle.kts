import org.gradle.api.GradleException
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

plugins {
    java
    application
}

repositories {

    google()
    mavenLocal()
    mavenCentral()
    maven {
        name = "Central Portal Snapshots"
        url = uri("https://central.sonatype.com/repository/maven-snapshots/")

        // Only search this repository for the specific dependency
        content {
            includeModule("org.hl7.fhir", "kindling")
            includeModule("ca.uhn.hapi.fhir","org.hl7.fhir.core")
            includeModule("ca.uhn.hapi.fhir","org.hl7.fhir.utilities")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.dstu2")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.dstu2016may")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.dstu3")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.dstu3.support")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.r4")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.r4b")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.r5")
            includeModule("ca.uhn.hapi.fhir","org.hl7.fhir.convertors")
            includeModule("ca.uhn.hapi.fhir", "org.hl7.fhir.validation")
            includeModule("ca.uhn.hapi.fhir","org.hl7.fhir.model")
            includeModule("ca.uhn.hapi.fhir","org.hl7.fhir.support")
        }
    }
    maven {
        url = uri("https://jitpack.io")
    }
    maven {
        url = uri("https://plugins.gradle.org/m2/")
    }
}

dependencies {
    implementation("org.hl7.fhir:kindling:${property("kindlingVersion")}")
}

data class ShexArtifact(val content: String, val extractedFromHtml: Boolean)

fun decodeHtmlEntities(value: String): String {
    val numericEntity = Regex("&#(x?[0-9A-Fa-f]+);")
    return numericEntity.replace(
        value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&amp;", "&")
    ) { match ->
        val rawCodePoint = match.groupValues[1]
        val codePoint = if (rawCodePoint.startsWith("x", ignoreCase = true)) {
            rawCodePoint.substring(1).toInt(16)
        } else {
            rawCodePoint.toInt()
        }
        String(Character.toChars(codePoint))
    }
}

fun readShexArtifact(file: File): ShexArtifact {
    val content = file.readText()
    val trimmed = content.trimStart()
    if (!trimmed.startsWith("<!DOCTYPE", ignoreCase = true) && !trimmed.startsWith("<html", ignoreCase = true)) {
        return ShexArtifact(content, false)
    }

    val preStartMatch = Regex("<pre[^>]*class=\"shex\"[^>]*>", RegexOption.IGNORE_CASE).find(content)
        ?: throw GradleException("Cannot extract raw ShEx from ${file.path}: no ShEx <pre> block was found.")
    val preStart = preStartMatch.range.last + 1
    val preEnd = content.indexOf("</pre>", preStart, ignoreCase = true)
    if (preEnd == -1) {
        throw GradleException("Cannot extract raw ShEx from ${file.path}: the ShEx <pre> block is not closed.")
    }

    return ShexArtifact(decodeHtmlEntities(content.substring(preStart, preEnd)).trimEnd() + "\n", true)
}

fun refreshShexSchemaZip() {
    val publishDir = file("publish")
    if (!publishDir.isDirectory) {
        throw GradleException("Cannot package ShEx schemas because ${publishDir.path} does not exist.")
    }

    val artifacts = linkedMapOf<String, ShexArtifact>()
    publishDir.listFiles()
        ?.filter { it.isFile && (it.name.endsWith(".shex") || it.name.endsWith(".shex.html")) }
        ?.sortedBy { it.name }
        ?.forEach { shexFile ->
            val entryName = shexFile.name.removeSuffix(".html")
            val artifact = readShexArtifact(shexFile)
            val existing = artifacts[entryName]
            if (existing == null || (existing.extractedFromHtml && !artifact.extractedFromHtml)) {
                artifacts[entryName] = artifact
            }
        }

    if (artifacts.isEmpty()) {
        throw GradleException("Cannot package ShEx schemas because no generated ShEx artifacts were found in ${publishDir.path}.")
    }

    val zipFile = publishDir.resolve("fhir.schema.shex.zip")
    ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
        artifacts.forEach { (entryName, artifact) ->
            zip.putNextEntry(ZipEntry(entryName))
            zip.write(artifact.content.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
    }
    logger.lifecycle("Packaged ${artifacts.size} ShEx schemas into ${zipFile.path}")
}

tasks.register("packageShexSchemas") {
    group = "publishing"
    description = "Packages all generated ShEx schemas into publish/fhir.schema.shex.zip."
    doLast {
        refreshShexSchemaZip()
    }
}

task("publish", JavaExec::class) {
    dependsOn(":printVersion")
    if (properties["logback.configurationFile"] != null) {
        jvmArgs = listOf("-Dlogback.configurationFile=${properties["logback.configurationFile"]}")
    }
    main = "org.hl7.fhir.tools.publisher.Publisher"
    classpath = sourceSets["main"].compileClasspath
    doLast {
        refreshShexSchemaZip()
    }
}

task("publishFull", JavaExec::class) {
    dependsOn(":printVersion")
    if (properties["logback.configurationFile"] != null) {
        jvmArgs = listOf("-Dlogback.configurationFile=${properties["logback.configurationFile"]}")
    }
    main = "org.hl7.fhir.tools.publisher.Publisher"
    classpath = sourceSets["main"].compileClasspath
    args("-nopartial")
    doLast {
        refreshShexSchemaZip()
    }
}

task("printVersion") {
    println("\nKicking off FHIR publishing job!" +
            "\n\n==============================" +
            "\nGenerating code using kindling version ${properties["kindlingVersion"]}" +
            "\nFor more information on kindling, and to check latest version, check here:" +
            "\nhttps://github.com/HL7/kindling" +
            "\n"+
            "\nVerbose or customized output can be further configured using the logback.configurationFile gradle property:"+
            "\n"+
            "\n  ./gradlew publish -Plogback.configurationFile=~/my-logback-config.xml"+
            "\n"+
            "\n==============================")
}

configure<JavaPluginConvention> {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
