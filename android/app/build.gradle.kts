plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.norom.padelaudio"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.norom.padelaudio"
        // One phone, Android 12+: lets audio routing use setCommunicationDevice only.
        minSdk = 31
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // One phone. Each extra ABI is another 10 MB of libvosk, so the
        // emulator's is only added when asked for: ./gradlew assembleDebug -Pemulator
        ndk {
            abiFilters += "arm64-v8a"
            if (project.hasProperty("emulator")) abiFilters += "x86_64"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // The web app is not copied into the source tree; it is staged into the
    // build directory so there is exactly one copy of it in the repository.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("webapp"))

    // The speech model, fetched by tools/fetch-model.sh rather than committed.
    sourceSets["main"].assets.srcDir(rootProject.layout.projectDirectory.dir("model-assets"))
}

/**
 * Stage the scoreboard into the APK.
 *
 * The wrapper deliberately has no INTERNET permission, so every file the page
 * loads has to be inside the APK.
 */
val stageWebApp by tasks.registering(Copy::class) {
    val webRoot = rootProject.projectDir.parentFile

    from(webRoot) {
        include(
            "index.html",
            "styles.css",
            "src/**/*.js",
            "icons/**",
        )
        exclude("src/**/*.test.js")
    }
    into(layout.buildDirectory.dir("webapp"))
}

/**
 * Without the model the APK builds, installs, and then cannot hear — which
 * looks like a microphone problem on court. Failing here says what is wrong.
 */
val checkSpeechModel by tasks.registering {
    val marker = rootProject.layout.projectDirectory.file("model-assets/model-ru/uuid")

    doLast {
        if (!marker.asFile.exists()) {
            throw GradleException("Speech model missing. Run tools/fetch-model.sh first.")
        }
    }
}

tasks.named("preBuild") { dependsOn(stageWebApp, checkSpeechModel) }

dependencies {
    // WebViewAssetLoader: serves the assets over an https origin so ES modules
    // load, which they do not over file://.
    implementation("androidx.webkit:webkit:1.8.0")

    // On-device speech recognition. JNA is how the Java side reaches libvosk.
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
}
