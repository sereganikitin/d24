plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ru.uk.ds24kiosk"
    compileSdk = 34

    defaultConfig {
        applicationId = "ru.uk.ds24kiosk"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // ПИН для входа в меню обслуживания (долгий тап в правом нижнем углу).
        // Смените перед боевой установкой.
        buildConfigField("String", "ADMIN_PIN", "\"2468\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    // "dev" flavor: обычное приложение для тестирования на личном телефоне —
    // не перехватывает кнопку Home и не входит в lock task само.
    // "kiosk" flavor: боевая сборка для планшета на входе — полный kiosk-режим.
    flavorDimensions += "mode"
    productFlavors {
        create("dev") {
            dimension = "mode"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("boolean", "IS_KIOSK", "false")
        }
        create("kiosk") {
            dimension = "mode"
            buildConfigField("boolean", "IS_KIOSK", "true")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
