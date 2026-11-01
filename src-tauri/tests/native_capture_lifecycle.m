// Exercise the native callback ordering without requesting capture permissions.
#import "../src/native_capture.m"
#include <assert.h>

int main(void) {
  @autoreleasepool {
    MochiRecordingDelegate *recorder = [[MochiRecordingDelegate alloc] init];
    assert(![recorder isRecording]);
    assert(![recorder waitForRecording:NO timeout:0.01]);
    [recorder recordingOutputDidStartRecording:nil];
    assert([recorder waitForRecording:NO timeout:0.01]);
    assert([recorder isRecording]);
    // A successful stream stop is not enough: the writer finishes later.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
      [recorder recordingOutputDidFinishRecording:nil];
    });
    assert([recorder waitForRecording:YES timeout:1]);
    assert(![recorder isRecording]);

    MochiRecordingDelegate *interrupted = [[MochiRecordingDelegate alloc] init];
    [interrupted recordingOutputDidStartRecording:nil];
    NSError *streamError = [NSError errorWithDomain:@"MOCHI-test" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Stream interrupted"}];
    [interrupted stream:nil didStopWithError:streamError];
    assert(![interrupted isRecording]);
    assert([[interrupted failureMessage] isEqualToString:@"Stream interrupted"]);
    // An interrupted stream can still produce a properly finalized file.
    [interrupted recordingOutputDidFinishRecording:nil];
    assert([interrupted waitForRecording:YES timeout:0.01]);

    MochiRecordingDelegate *failed = [[MochiRecordingDelegate alloc] init];
    [failed recordingOutput:nil didFailWithError:streamError];
    assert(![failed waitForRecording:NO timeout:1]);
    assert(![failed waitForRecording:YES timeout:1]);
    assert(![failed isRecording]);
    printf("Native recording lifecycle: startup, delayed finish, interruption, and writer failure passed.\n");
  }
  return 0;
}
