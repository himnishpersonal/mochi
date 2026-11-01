use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=src/native_capture.m");
    println!("cargo:rerun-if-changed=src/audio_tap.m");
    println!("cargo:rerun-if-changed=src/macos_window.m");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_macos_window_bridge();
    }
    if env::var_os("CARGO_FEATURE_NATIVE_SYSTEM_AUDIO").is_some()
        && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
    {
        build_native_capture_bridge();
    }
    tauri_build::build()
}

fn build_macos_window_bridge() {
    build_objc_bridge("src/macos_window.m", "mochi_macos_window", &["AppKit", "Foundation"]);
}

fn command_output(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("Could not run {program}: {error}"));
    if !output.status.success() {
        panic!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8(output.stdout)
        .expect("Tool output was not UTF-8")
        .trim()
        .to_owned()
}

fn build_native_capture_bridge() {
    build_objc_bridge(
        "src/native_capture.m",
        "mochi_native_capture",
        &["AVFoundation", "AudioToolbox", "CoreGraphics", "CoreMedia", "Foundation", "ScreenCaptureKit"],
    );
    build_objc_bridge("src/audio_tap.m", "mochi_audio_tap", &["AVFoundation", "AudioToolbox", "CoreAudio", "CoreMedia", "Foundation"]);
}

fn build_objc_bridge(source: &str, library: &str, frameworks: &[&str]) {
    let output_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is missing"));
    let object = output_dir.join(format!("{library}.o"));
    let archive = output_dir.join(format!("lib{library}.a"));
    let sdk = command_output("xcrun", &["--sdk", "macosx", "--show-sdk-path"]);
    let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("Unsupported macOS capture architecture: {other:?}"),
    };
    let target = format!("{architecture}-apple-macosx15.0");
    let source = PathBuf::from(source);

    let status = Command::new("xcrun")
        .args(["clang", "-fobjc-arc", "-fblocks", "-O2", "-isysroot"])
        .arg(&sdk)
        .args(["-target", &target, "-c"])
        .arg(&source)
        .arg("-o")
        .arg(&object)
        .status()
        .expect("Could not run clang for MOCHI meeting capture");
    assert!(status.success(), "MOCHI's native capture bridge did not compile");

    let status = Command::new("libtool")
        .args(["-static", "-o"])
        .arg(&archive)
        .arg(&object)
        .status()
        .expect("Could not archive MOCHI's native capture bridge");
    assert!(status.success(), "MOCHI's native capture bridge did not archive");

    println!("cargo:rustc-link-search=native={}", output_dir.display());
    println!("cargo:rustc-link-lib=static={library}");
    for framework in frameworks {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
