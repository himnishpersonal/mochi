#import "../src/audio_tap.m"
#include <assert.h>

// Usage: audio_tap_fallback <existing-system-caf> <new-output-m4a>
// The source is read only; the output must not already exist.
int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 3);
    MochiTapSession *session = [MochiTapSession new];
    session.lock = [NSLock new];
    session.systemPath = [NSString stringWithUTF8String:argv[1]];
    session.microphonePath = @"/nonexistent-mochi-test-microphone.caf";
    session.outputPath = [NSString stringWithUTF8String:argv[2]];
    session.systemFrames = 1;
    session.microphoneFrames = 0;
    mochiTapSession = session;
    char message[2048] = {0};
    assert(mochi_audio_tap_stop(message, sizeof(message)));
    assert(strstr(message, "microphone delivered no audio"));
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:session.outputPath error:nil];
    assert([attributes fileSize] > 1024);
    printf("Missing-microphone fallback saved the Mac audio and returned a warning.\n");
  }
  return 0;
}
