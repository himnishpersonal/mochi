#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <math.h>

// System output and microphone have separate clocks. Keep each original file
// until the combined recording is successfully exported.
@interface MochiTapSession : NSObject
@property AudioObjectID tap;
@property AudioObjectID aggregate;
@property AudioDeviceIOProcID proc;
@property(nonatomic, strong) AVAudioEngine *microphone;
@property(nonatomic, strong) AVAudioFile *systemFile;
@property(nonatomic, strong) AVAudioFile *microphoneFile;
@property(nonatomic, strong) AVAudioFile *liveFile;
@property(nonatomic, strong) AVAudioFormat *systemFormat;
@property(nonatomic, strong) NSLock *lock;
@property(nonatomic, copy) NSString *outputPath;
@property(nonatomic, copy) NSString *systemPath;
@property(nonatomic, copy) NSString *microphonePath;
@property(nonatomic, copy) NSString *chunkDirectory;
@property(nonatomic, copy) NSString *livePartialPath;
@property(nonatomic, copy) NSString *failure;
@property(nonatomic, strong) NSDate *startedAt;
@property uint64_t systemFirstHost;
@property uint64_t microphoneFirstHost;
@property uint64_t systemFrames;
@property uint64_t microphoneFrames;
@property float systemPeak;
@property uint64_t liveStartFrame;
@property BOOL active;
@property BOOL microphoneTapInstalled;
@end
@implementation MochiTapSession
@end

static MochiTapSession *mochiTapSession;
static NSLock *mochiTapLock(void) { static NSLock *lock; static dispatch_once_t once; dispatch_once(&once, ^{ lock = [NSLock new]; }); return lock; }
static void mochiTapFinishChunk(MochiTapSession *s) {
  NSString *partial = s.livePartialPath; s.liveFile = nil; s.livePartialPath = nil;
  if (!partial) return;
  NSString *final = [partial stringByReplacingOccurrencesOfString:@".partial.caf" withString:@".caf"];
  [[NSFileManager defaultManager] moveItemAtPath:partial toPath:final error:nil];
}
static void mochiTapBeginChunk(MochiTapSession *s) {
  if (!s.chunkDirectory || s.systemFormat.sampleRate <= 0) return;
  int64_t offset = (int64_t)(1000.0 * s.systemFrames / s.systemFormat.sampleRate);
  s.liveStartFrame = s.systemFrames;
  s.livePartialPath = [s.chunkDirectory stringByAppendingPathComponent:[NSString stringWithFormat:@"audio-system-%lld.partial.caf", offset]];
  NSError *error = nil;
  s.liveFile = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:s.livePartialPath] settings:s.systemFormat.settings commonFormat:s.systemFormat.commonFormat interleaved:s.systemFormat.interleaved error:&error];
  if (!s.liveFile) { s.livePartialPath = nil; NSLog(@"MOCHI live transcript audio unavailable: %@", error.localizedDescription); }
}
static void mochiTapError(NSString *message, char *buffer, int32_t capacity) {
  if (!buffer || capacity <= 0) return;
  NSData *data = [message dataUsingEncoding:NSUTF8StringEncoding];
  NSUInteger count = MIN(data.length, (NSUInteger)capacity - 1);
  memcpy(buffer, data.bytes, count); buffer[count] = 0;
}
static void mochiTapClose(MochiTapSession *s) {
  if (s.aggregate != kAudioObjectUnknown && s.proc) { AudioDeviceStop(s.aggregate, s.proc); AudioDeviceDestroyIOProcID(s.aggregate, s.proc); s.proc = NULL; }
  [s.lock lock]; mochiTapFinishChunk(s); [s.lock unlock];
  if (s.microphone) { if (s.microphoneTapInstalled) [s.microphone.inputNode removeTapOnBus:0]; [s.microphone stop]; s.microphone = nil; }
  if (s.aggregate != kAudioObjectUnknown) { AudioHardwareDestroyAggregateDevice(s.aggregate); s.aggregate = kAudioObjectUnknown; }
  if (s.tap != kAudioObjectUnknown) { AudioHardwareDestroyProcessTap(s.tap); s.tap = kAudioObjectUnknown; }
  s.systemFile = nil; s.microphoneFile = nil; s.active = NO;
}
static NSString *mochiTapStatus(OSStatus status, NSString *action) { return [NSString stringWithFormat:@"%@ (Core Audio error %d).", action, (int)status]; }
static bool mochiTapFail(MochiTapSession *s, NSString *failure, char *buffer, int32_t capacity) {
  mochiTapClose(s); [mochiTapLock() lock]; if (mochiTapSession == s) mochiTapSession = nil; [mochiTapLock() unlock];
  mochiTapError(failure ?: @"Could not start audio recording.", buffer, capacity); return false;
}

bool mochi_audio_tap_start(const char *path, const char *chunkDirectory, char *errorBuffer, int32_t errorCapacity) {
  if (!path) { mochiTapError(@"Recording path is missing.", errorBuffer, errorCapacity); return false; }
  [mochiTapLock() lock];
  if (mochiTapSession) { [mochiTapLock() unlock]; mochiTapError(@"A meeting recording is already active.", errorBuffer, errorCapacity); return false; }
  MochiTapSession *s = [MochiTapSession new]; s.lock = [NSLock new]; s.outputPath = [NSString stringWithUTF8String:path];
  s.systemPath = [s.outputPath stringByAppendingString:@".system.caf"]; s.microphonePath = [s.outputPath stringByAppendingString:@".microphone.caf"];
  if (chunkDirectory) s.chunkDirectory = [NSString stringWithUTF8String:chunkDirectory];
  s.startedAt = [NSDate date]; mochiTapSession = s;
  [mochiTapLock() unlock];
  NSError *error = nil; OSStatus status = noErr;
  CATapDescription *description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
  description.UUID = [NSUUID UUID]; description.privateTap = YES; description.muteBehavior = CATapUnmuted;
  AudioObjectID tap = kAudioObjectUnknown; status = AudioHardwareCreateProcessTap(description, &tap); s.tap = tap;
  if (status != noErr) return mochiTapFail(s, mochiTapStatus(status, @"Could not create the system audio tap"), errorBuffer, errorCapacity);
  AudioObjectPropertyAddress formatAddress = { kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  AudioStreamBasicDescription streamFormat = {0}; UInt32 size = sizeof(streamFormat);
  status = AudioObjectGetPropertyData(s.tap, &formatAddress, 0, NULL, &size, &streamFormat);
  if (status != noErr || !(s.systemFormat = [[AVAudioFormat alloc] initWithStreamDescription:&streamFormat])) return mochiTapFail(s, mochiTapStatus(status, @"Could not read the system audio format"), errorBuffer, errorCapacity);
  NSDictionary *aggregate = @{@kAudioAggregateDeviceNameKey:@"MOCHI private system audio", @kAudioAggregateDeviceUIDKey:NSUUID.UUID.UUIDString,
    @kAudioAggregateDeviceIsPrivateKey:@YES, @kAudioAggregateDeviceTapAutoStartKey:@YES,
    @kAudioAggregateDeviceTapListKey:@[@{@kAudioSubTapUIDKey:description.UUID.UUIDString, @kAudioSubTapDriftCompensationKey:@YES}]};
  AudioObjectID aggregateID = kAudioObjectUnknown; status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &aggregateID); s.aggregate = aggregateID;
  if (status != noErr) return mochiTapFail(s, mochiTapStatus(status, @"Could not create the private audio device"), errorBuffer, errorCapacity);
  s.systemFile = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:s.systemPath] settings:s.systemFormat.settings commonFormat:s.systemFormat.commonFormat interleaved:s.systemFormat.interleaved error:&error];
  if (!s.systemFile) return mochiTapFail(s, [NSString stringWithFormat:@"Could not prepare system audio: %@", error.localizedDescription], errorBuffer, errorCapacity);
  mochiTapBeginChunk(s);
  s.microphone = [AVAudioEngine new]; AVAudioInputNode *input = s.microphone.inputNode;
  AVAudioFormat *micFormat = [input outputFormatForBus:0];
  if (!micFormat || micFormat.sampleRate <= 0 || micFormat.channelCount == 0) return mochiTapFail(s, @"No usable microphone is available.", errorBuffer, errorCapacity);
  s.microphoneFile = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:s.microphonePath] settings:micFormat.settings commonFormat:micFormat.commonFormat interleaved:micFormat.interleaved error:&error];
  if (!s.microphoneFile) return mochiTapFail(s, [NSString stringWithFormat:@"Could not prepare microphone audio: %@", error.localizedDescription], errorBuffer, errorCapacity);
  [input installTapOnBus:0 bufferSize:4096 format:micFormat block:^(AVAudioPCMBuffer *buffer, AVAudioTime *time) {
    NSError *writeError = nil; [s.lock lock];
    if (!s.microphoneFirstHost && time.hostTimeValid) s.microphoneFirstHost = time.hostTime;
    if (s.microphoneFile && ![s.microphoneFile writeFromBuffer:buffer error:&writeError]) { s.failure = writeError.localizedDescription; s.active = NO; }
    s.microphoneFrames += buffer.frameLength; [s.lock unlock];
  }];
  s.microphoneTapInstalled = YES;
  if (![s.microphone startAndReturnError:&error]) return mochiTapFail(s, [NSString stringWithFormat:@"Could not start microphone: %@", error.localizedDescription], errorBuffer, errorCapacity);
  dispatch_queue_t queue = dispatch_queue_create("app.mochi.audio-tap", DISPATCH_QUEUE_SERIAL);
  AudioDeviceIOProcID proc = NULL;
  status = AudioDeviceCreateIOProcIDWithBlock(&proc, s.aggregate, queue, ^(const AudioTimeStamp *now, const AudioBufferList *inputData, const AudioTimeStamp *inputTime, AudioBufferList *outputData, const AudioTimeStamp *outputTime) {
    if (!inputData || !inputData->mNumberBuffers || !inputData->mBuffers[0].mDataByteSize) return;
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:s.systemFormat bufferListNoCopy:inputData deallocator:nil];
    if (!buffer) return;
    NSError *writeError = nil; [s.lock lock];
    if (!s.systemFirstHost && (inputTime->mFlags & kAudioTimeStampHostTimeValid)) s.systemFirstHost = inputTime->mHostTime;
    float peak = 0;
    if (s.systemFormat.commonFormat == AVAudioPCMFormatFloat32) {
      for (UInt32 channel = 0; channel < inputData->mNumberBuffers; channel++) {
        const float *samples = inputData->mBuffers[channel].mData;
        for (UInt32 index = 0; samples && index < inputData->mBuffers[channel].mDataByteSize / sizeof(float); index++) {
          if (isfinite(samples[index])) peak = fmaxf(peak, fabsf(samples[index]));
        }
      }
    }
    s.systemPeak = fmaxf(peak, s.systemPeak * 0.9f);
    if (s.systemFile && ![s.systemFile writeFromBuffer:buffer error:&writeError]) { s.failure = writeError.localizedDescription; s.active = NO; }
    if (s.liveFile && ![s.liveFile writeFromBuffer:buffer error:&writeError]) { s.liveFile = nil; s.livePartialPath = nil; }
    s.systemFrames += buffer.frameLength; [s.lock unlock];
    if (s.systemFrames - s.liveStartFrame >= (uint64_t)(s.systemFormat.sampleRate * 6)) {
      [s.lock lock]; mochiTapFinishChunk(s); mochiTapBeginChunk(s); [s.lock unlock];
    }
  });
  s.proc = proc;
  if (status != noErr) return mochiTapFail(s, mochiTapStatus(status, @"Could not prepare system audio capture"), errorBuffer, errorCapacity);
  status = AudioDeviceStart(s.aggregate, s.proc);
  if (status != noErr) return mochiTapFail(s, mochiTapStatus(status, @"Could not start system audio. Check System Audio Recording permission"), errorBuffer, errorCapacity);
  s.active = YES; return true;
}

bool mochi_audio_tap_stop(char *errorBuffer, int32_t errorCapacity) {
  [mochiTapLock() lock]; MochiTapSession *s = mochiTapSession; [mochiTapLock() unlock];
  if (!s) { mochiTapError(@"No audio recording is active.", errorBuffer, errorCapacity); return false; }
  mochiTapClose(s);
  [mochiTapLock() lock]; if (mochiTapSession == s) mochiTapSession = nil; [mochiTapLock() unlock];
  if (s.failure || (!s.systemFrames && !s.microphoneFrames)) {
    mochiTapError([NSString stringWithFormat:@"Audio was incomplete (%@). Separate files were kept at %@ and %@.", s.failure ?: @"one source delivered no samples", s.systemPath, s.microphonePath], errorBuffer, errorCapacity); return false;
  }
  AVMutableComposition *composition = [AVMutableComposition composition];
  uint64_t earliest = s.systemFirstHost && s.microphoneFirstHost ? MIN(s.systemFirstHost, s.microphoneFirstHost) : 0;
  NSArray<NSString *> *paths = @[s.systemPath, s.microphonePath];
  uint64_t hosts[] = { s.systemFirstHost, s.microphoneFirstHost };
  for (NSUInteger i = 0; i < paths.count; i++) {
    if ((i == 0 && !s.systemFrames) || (i == 1 && !s.microphoneFrames)) continue;
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:paths[i]] options:nil];
    AVAssetTrack *source = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
    AVMutableCompositionTrack *track = [composition addMutableTrackWithMediaType:AVMediaTypeAudio preferredTrackID:kCMPersistentTrackID_Invalid];
    NSError *error = nil;
    double offset = earliest && hosts[i] >= earliest ? (double)AudioConvertHostTimeToNanos(hosts[i] - earliest) / 1e9 : 0;
    if (!source || ![track insertTimeRange:CMTimeRangeMake(kCMTimeZero, asset.duration) ofTrack:source atTime:CMTimeMakeWithSeconds(offset, 48000) error:&error]) {
      mochiTapError([NSString stringWithFormat:@"Could not combine audio (%@). Separate files were kept at %@ and %@.", error.localizedDescription ?: @"missing source", s.systemPath, s.microphonePath], errorBuffer, errorCapacity); return false;
    }
  }
  AVAssetExportSession *exporter = [[AVAssetExportSession alloc] initWithAsset:composition presetName:AVAssetExportPresetAppleM4A];
  if (!exporter) { mochiTapError(@"Could not prepare audio export; separate source files were kept.", errorBuffer, errorCapacity); return false; }
  exporter.outputURL = [NSURL fileURLWithPath:s.outputPath]; exporter.outputFileType = AVFileTypeAppleM4A;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [exporter exportAsynchronouslyWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC)) != 0 || exporter.status != AVAssetExportSessionStatusCompleted) {
    [exporter cancelExport];
    mochiTapError([NSString stringWithFormat:@"Could not finalize combined audio (%@). Separate files were kept at %@ and %@.", exporter.error.localizedDescription ?: @"export timed out", s.systemPath, s.microphonePath], errorBuffer, errorCapacity); return false;
  }
  // Keep the separate sources until Rust has committed the combined recording
  // and attached it to its note. They are recovery files if that step fails.
  if (!s.microphoneFrames) mochiTapError(@"Mac audio was saved, but the microphone delivered no audio. Check your input device and microphone access.", errorBuffer, errorCapacity);
  else if (!s.systemFrames) mochiTapError(@"Microphone audio was saved, but Mac audio delivered no samples. Check System Audio Recording access.", errorBuffer, errorCapacity);
  return true;
}
bool mochi_audio_tap_is_active(void) { [mochiTapLock() lock]; BOOL active = mochiTapSession.active; [mochiTapLock() unlock]; return active; }
bool mochi_audio_tap_has_samples(void) { [mochiTapLock() lock]; MochiTapSession *s = mochiTapSession; [s.lock lock]; BOOL result = s && s.systemFrames > 0; [s.lock unlock]; [mochiTapLock() unlock]; return result; }
float mochi_audio_tap_level(void) { [mochiTapLock() lock]; MochiTapSession *s = mochiTapSession; [s.lock lock]; float level = s ? s.systemPeak : 0; [s.lock unlock]; [mochiTapLock() unlock]; return level; }
int64_t mochi_audio_tap_duration_seconds(void) { [mochiTapLock() lock]; NSTimeInterval value = mochiTapSession ? -[mochiTapSession.startedAt timeIntervalSinceNow] : 0; [mochiTapLock() unlock]; return (int64_t)value; }
int64_t mochi_audio_tap_file_bytes(void) { [mochiTapLock() lock]; NSString *path = mochiTapSession.systemPath; [mochiTapLock() unlock]; return path ? [[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil] fileSize] : 0; }
bool mochi_audio_tap_microphone_permission(void) { return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusAuthorized; }
void mochi_audio_tap_request_microphone(void) { if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusNotDetermined) [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(__unused BOOL granted) {}]; }
void mochi_audio_tap_last_error(char *buffer, int32_t capacity) { [mochiTapLock() lock]; NSString *error = mochiTapSession.failure; [mochiTapLock() unlock]; mochiTapError(error ?: @"The audio stream stopped unexpectedly.", buffer, capacity); }
