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
        versionName = "0.1"
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

tasks.named("preBuild") { dependsOn(stageWebApp) }

dependencies {
    // WebViewAssetLoader: serves the assets over an https origin so ES modules
    // load, which they do not over file://.
    implementation("androidx.webkit:webkit:1.8.0")
}
