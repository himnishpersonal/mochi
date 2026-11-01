#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

extern bool mochi_audio_tap_start(const char *, const char *, char *, int32_t);
extern bool mochi_audio_tap_stop(char *, int32_t);
extern bool mochi_audio_tap_has_samples(void);

static void result(NSString *directory, NSString *message) {
  [message writeToFile:[directory stringByAppendingPathComponent:@"result.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *directory = [NSString stringWithUTF8String:argv[1]];
    [NSApplication sharedApplication];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      dispatch_semaphore_t mic = dispatch_semaphore_create(0);
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) { dispatch_semaphore_signal(mic); }];
      if (dispatch_semaphore_wait(mic, dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC)) != 0 || [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) {
        result(directory, @"Microphone permission was not granted."); dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; }); return;
      }
      char error[4096] = {0};
      NSString *path = [directory stringByAppendingPathComponent:@"probe.partial.mp4"];
      if (!mochi_audio_tap_start(path.fileSystemRepresentation, directory.fileSystemRepresentation, error, sizeof(error))) {
        result(directory, [NSString stringWithFormat:@"Start failed: %s", error]); dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; }); return;
      }
      for (int i = 0; i < 4; i++) {
        NSTask *play = [NSTask new]; play.executableURL = [NSURL fileURLWithPath:@"/usr/bin/afplay"]; play.arguments = @[@"/System/Library/Sounds/Glass.aiff"];
        [play launchAndReturnError:nil]; [play waitUntilExit]; [NSThread sleepForTimeInterval:1];
      }
      BOOL gotSamples = mochi_audio_tap_has_samples();
      if (!mochi_audio_tap_stop(error, sizeof(error))) result(directory, [NSString stringWithFormat:@"Stop failed (system callbacks %@): %s", gotSamples ? @"received" : @"missing", error]);
      else result(directory, [NSString stringWithFormat:@"OK system callbacks=%@ file=%@", gotSamples ? @"yes" : @"no", path]);
      dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
    });
    [NSApp run];
  }
  return 0;
}
