#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <objc/runtime.h>

@interface MochiRecordingDelegate : NSObject <SCRecordingOutputDelegate, SCStreamDelegate>
@property(nonatomic, copy, nullable) NSString *failure;
@property(nonatomic, copy, nullable) NSString *streamFailure;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL streamStopped;
- (BOOL)waitForRecording:(BOOL)finish timeout:(NSTimeInterval)timeout;
- (BOOL)isRecording;
- (NSString *)failureMessage;
@end

@implementation MochiRecordingDelegate
- (instancetype)init {
  if ((self = [super init])) self.condition = [[NSCondition alloc] init];
  return self;
}
- (void)recordingOutputDidStartRecording:(SCRecordingOutput *)recordingOutput {
  [self.condition lock]; self.started = YES; [self.condition broadcast]; [self.condition unlock];
}
- (void)recordingOutputDidFinishRecording:(SCRecordingOutput *)recordingOutput {
  [self.condition lock]; self.finished = YES; [self.condition broadcast]; [self.condition unlock];
}
- (void)recordingOutput:(SCRecordingOutput *)recordingOutput didFailWithError:(NSError *)error {
  [self.condition lock]; self.failure = error.localizedDescription; [self.condition broadcast]; [self.condition unlock];
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  [self.condition lock]; self.streamStopped = YES;
  self.streamFailure = error.localizedDescription;
  [self.condition broadcast]; [self.condition unlock];
}
- (BOOL)waitForRecording:(BOOL)finish timeout:(NSTimeInterval)timeout {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  [self.condition lock];
  while (!(finish ? self.finished : self.started) && self.failure == nil && (finish || !self.streamStopped)) {
    if (![self.condition waitUntilDate:deadline]) break;
  }
  BOOL ready = (finish ? self.finished : (self.started && !self.finished && !self.streamStopped)) && self.failure == nil;
  [self.condition unlock];
  return ready;
}
- (BOOL)isRecording {
  [self.condition lock];
  BOOL active = self.started && !self.finished && !self.streamStopped && self.failure == nil;
  [self.condition unlock]; return active;
}
- (NSString *)failureMessage {
  [self.condition lock]; NSString *failure = self.failure ?: self.streamFailure; [self.condition unlock]; return failure;
}
@end

@interface MochiAudioChunker : NSObject
@property(nonatomic, copy) NSString *directory;
@property(nonatomic, copy) NSString *source;
@property(nonatomic, strong) AVAssetWriter *writer;
@property(nonatomic, strong) AVAssetWriterInput *input;
@property(nonatomic, strong) NSURL *partialURL;
@property(nonatomic) CMTime firstTime;
@property(nonatomic) CMTime chunkStart;
@property(nonatomic) int64_t chunkOffsetMs;
- (void)append:(CMSampleBufferRef)sample firstTime:(CMTime)firstTime;
- (void)finish;
- (void)finishWithCompletion:(dispatch_block_t)completion;
@end

@implementation MochiAudioChunker
- (void)beginAt:(CMTime)time sample:(CMSampleBufferRef)sample firstTime:(CMTime)firstTime {
  self.chunkStart = time;
  self.chunkOffsetMs = (int64_t)MAX(0, CMTimeGetSeconds(CMTimeSubtract(time, firstTime)) * 1000.0);
  NSString *base = [NSString stringWithFormat:@"audio-%@-%lld", self.source, self.chunkOffsetMs];
  self.partialURL = [NSURL fileURLWithPath:[[self.directory stringByAppendingPathComponent:[base stringByAppendingString:@".partial.m4a"]] stringByStandardizingPath]];
  NSURL *finalURL = [NSURL fileURLWithPath:[self.directory stringByAppendingPathComponent:[base stringByAppendingString:@".m4a"]]];
  [[NSFileManager defaultManager] removeItemAtURL:self.partialURL error:nil];
  [[NSFileManager defaultManager] removeItemAtURL:finalURL error:nil];

  NSError *error = nil;
  self.writer = [[AVAssetWriter alloc] initWithURL:self.partialURL fileType:AVFileTypeAppleM4A error:&error];
  if (!self.writer) { NSLog(@"MOCHI live audio writer: %@", error); return; }
  NSDictionary *settings = @{
    AVFormatIDKey: @(kAudioFormatMPEG4AAC),
    AVSampleRateKey: @16000,
    AVNumberOfChannelsKey: @1,
    AVEncoderBitRateKey: @32000
  };
  self.input = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio
                                              outputSettings:settings
                                            sourceFormatHint:CMSampleBufferGetFormatDescription(sample)];
  self.input.expectsMediaDataInRealTime = YES;
  if (![self.writer canAddInput:self.input]) { self.writer = nil; self.input = nil; return; }
  [self.writer addInput:self.input];
  if (![self.writer startWriting]) { self.writer = nil; self.input = nil; return; }
  [self.writer startSessionAtSourceTime:time];
}

- (void)append:(CMSampleBufferRef)sample firstTime:(CMTime)firstTime {
  CMTime time = CMSampleBufferGetPresentationTimeStamp(sample);
  if (!CMTIME_IS_NUMERIC(time)) return;
  if (!self.writer || CMTimeGetSeconds(CMTimeSubtract(time, self.chunkStart)) >= 5.0) {
    [self finish];
    [self beginAt:time sample:sample firstTime:firstTime];
  }
  if (self.input && self.writer.status == AVAssetWriterStatusWriting && self.input.readyForMoreMediaData) {
    if (![self.input appendSampleBuffer:sample]) NSLog(@"MOCHI live %@ audio append failed: %@", self.source, self.writer.error);
  }
}

- (void)finish {
  [self finishWithCompletion:nil];
}

- (void)finishWithCompletion:(dispatch_block_t)completion {
  AVAssetWriter *writer = self.writer;
  AVAssetWriterInput *input = self.input;
  NSURL *partial = self.partialURL;
  int64_t offset = self.chunkOffsetMs;
  if (!writer || !input) { self.writer = nil; self.input = nil; if (completion) completion(); return; }
  self.writer = nil; self.input = nil; self.partialURL = nil;
  [input markAsFinished];
  if (writer.status != AVAssetWriterStatusWriting) { if (completion) completion(); return; }
  [writer finishWritingWithCompletionHandler:^{
    if (writer.status != AVAssetWriterStatusCompleted) {
      NSLog(@"MOCHI live %@ audio finish failed: %@", self.source, writer.error);
      if (completion) completion();
      return;
    }
    NSString *base = [NSString stringWithFormat:@"audio-%@-%lld", self.source, offset];
    NSURL *finalURL = [NSURL fileURLWithPath:[self.directory stringByAppendingPathComponent:[base stringByAppendingString:@".m4a"]]];
    NSError *moveError = nil;
    [[NSFileManager defaultManager] moveItemAtURL:partial toURL:finalURL error:&moveError];
    if (moveError) NSLog(@"MOCHI live audio chunk commit failed: %@", moveError);
    if (completion) completion();
  }];
}
@end

@interface MochiCaptureSession : NSObject <SCStreamOutput>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) SCRecordingOutput *output;
@property(nonatomic, strong) MochiRecordingDelegate *recordingDelegate;
@property(nonatomic, strong) NSDate *startedAt;
@property(nonatomic, copy) NSString *outputPath;
@property(nonatomic, copy) NSString *chunkDirectory;
@property(nonatomic, strong) MochiAudioChunker *systemChunks;
@property(nonatomic) CMTime firstAudioTime;
@property(nonatomic, strong) dispatch_queue_t audioQueue;
@end

@implementation MochiCaptureSession
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeAudio && type != SCStreamOutputTypeMicrophone) return;
  CMTime time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (!CMTIME_IS_NUMERIC(time)) return;
  if (!CMTIME_IS_NUMERIC(self.firstAudioTime)) self.firstAudioTime = time;
  if (type == SCStreamOutputTypeAudio) [self.systemChunks append:sampleBuffer firstTime:self.firstAudioTime];
}
- (void)finishLiveChunks {
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  dispatch_async(self.audioQueue, ^{
    [self.systemChunks finishWithCompletion:^{ dispatch_semaphore_signal(semaphore); }];
  });
  dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
}
@end

static NSLock *MochiCaptureLock(void) {
  static NSLock *lock;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ lock = [[NSLock alloc] init]; });
  return lock;
}

static MochiCaptureSession *activeCapture;

static void MochiWriteError(NSString *message, char *buffer, int32_t capacity) {
  if (buffer == NULL || capacity <= 0) return;
  NSData *data = [message dataUsingEncoding:NSUTF8StringEncoding];
  NSInteger count = MIN((NSInteger)data.length, (NSInteger)capacity - 1);
  if (count > 0) memcpy(buffer, data.bytes, (size_t)count);
  buffer[count] = '\0';
}

bool mochi_capture_microphone_preflight(void) {
  return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusAuthorized;
}

bool mochi_capture_screen_preflight(void) {
  return CGPreflightScreenCaptureAccess();
}

bool mochi_capture_preflight(void) {
  return mochi_capture_screen_preflight() && mochi_capture_microphone_preflight();
}

bool mochi_capture_request_permission(void) {
  BOOL screen = mochi_capture_screen_preflight();
  if (!screen) screen = CGRequestScreenCaptureAccess();
  AVAuthorizationStatus microphone = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (microphone == AVAuthorizationStatusNotDetermined) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(__unused BOOL granted) {}];
  }
  return screen && mochi_capture_microphone_preflight();
}

bool mochi_capture_start(const char *path, const char *chunkDirectory, char *errorBuffer, int32_t errorCapacity) {
  if (@available(macOS 15.0, *)) {
    if (path == NULL || chunkDirectory == NULL) {
      MochiWriteError(@"The local recording path is missing.", errorBuffer, errorCapacity);
      return false;
    }
    if (!mochi_capture_preflight()) {
      MochiWriteError(@"Screen & System Audio and Microphone permissions are required. Grant access in System Settings, then reopen MOCHI.", errorBuffer, errorCapacity);
      return false;
    }
    [MochiCaptureLock() lock];
    BOOL alreadyActive = activeCapture != nil;
    [MochiCaptureLock() unlock];
    if (alreadyActive) {
      MochiWriteError(@"A meeting recording is already active.", errorBuffer, errorCapacity);
      return false;
    }

    NSString *outputPath = [NSString stringWithUTF8String:path];
    NSString *chunksPath = [NSString stringWithUTF8String:chunkDirectory];
    NSError *directoryError = nil;
    [[NSFileManager defaultManager] createDirectoryAtPath:chunksPath withIntermediateDirectories:YES attributes:nil error:&directoryError];
    if (directoryError) { MochiWriteError(directoryError.localizedDescription, errorBuffer, errorCapacity); return false; }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block MochiCaptureSession *created = nil;
    __block NSString *failure = nil;
    NSLock *startupLock = [[NSLock alloc] init];
    __block BOOL cancelled = NO;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                               onScreenWindowsOnly:NO
                                                 completionHandler:^(SCShareableContent *content, NSError *contentError) {
      [startupLock lock]; BOOL abandoned = cancelled; [startupLock unlock];
      if (abandoned) { dispatch_semaphore_signal(semaphore); return; }
      if (contentError != nil || content.displays.count == 0) {
        failure = contentError.localizedDescription ?: @"No display is available for system-audio capture.";
        dispatch_semaphore_signal(semaphore);
        return;
      }
      pid_t ownPID = NSProcessInfo.processInfo.processIdentifier;
      NSPredicate *notMochi = [NSPredicate predicateWithBlock:^BOOL(SCRunningApplication *application, NSDictionary *bindings) {
        return application.processID == ownPID;
      }];
      NSArray<SCRunningApplication *> *excluded = [content.applications filteredArrayUsingPredicate:notMochi];
      SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject
                                                   excludingApplications:excluded
                                                        exceptingWindows:@[]];
      SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
      configuration.width = 64;
      configuration.height = 64;
      configuration.minimumFrameInterval = CMTimeMake(1, 1);
      configuration.showsCursor = NO;
      configuration.capturesAudio = YES;
      configuration.captureMicrophone = YES;
      configuration.excludesCurrentProcessAudio = YES;
      configuration.sampleRate = 48000;
      configuration.channelCount = 2;

      SCRecordingOutputConfiguration *recordingConfiguration = [[SCRecordingOutputConfiguration alloc] init];
      recordingConfiguration.outputURL = [NSURL fileURLWithPath:outputPath];
      recordingConfiguration.videoCodecType = AVVideoCodecTypeH264;
      recordingConfiguration.outputFileType = AVFileTypeMPEG4;
      MochiRecordingDelegate *delegate = [[MochiRecordingDelegate alloc] init];
      SCRecordingOutput *output = [[SCRecordingOutput alloc] initWithConfiguration:recordingConfiguration delegate:delegate];
      SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:delegate];
      NSError *addError = nil;
      MochiCaptureSession *audioDelegate = [[MochiCaptureSession alloc] init];
      audioDelegate.chunkDirectory = chunksPath;
      audioDelegate.audioQueue = dispatch_queue_create("ai.mochi.live-audio", DISPATCH_QUEUE_SERIAL);
      audioDelegate.systemChunks = [[MochiAudioChunker alloc] init];
      audioDelegate.systemChunks.directory = chunksPath;
      audioDelegate.systemChunks.source = @"system";
      audioDelegate.firstAudioTime = kCMTimeInvalid;
      if (![stream addStreamOutput:audioDelegate type:SCStreamOutputTypeAudio sampleHandlerQueue:audioDelegate.audioQueue error:&addError]) {
        failure = addError.localizedDescription ?: @"Could not attach live audio transcription.";
        dispatch_semaphore_signal(semaphore);
        return;
      }
      if (![stream addRecordingOutput:output error:&addError]) {
        failure = addError.localizedDescription ?: @"Could not attach the local meeting recorder.";
        dispatch_semaphore_signal(semaphore);
        return;
      }
      [stream startCaptureWithCompletionHandler:^(NSError *startError) {
        [startupLock lock];
        if (cancelled) {
          [startupLock unlock];
          [stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {}];
          dispatch_semaphore_signal(semaphore);
          return;
        }
        if (startError != nil) {
          failure = startError.localizedDescription;
        } else {
          created = [[MochiCaptureSession alloc] init];
          created.stream = stream;
          created.output = output;
          created.recordingDelegate = delegate;
          created.startedAt = [NSDate date];
          created.outputPath = outputPath;
          created.chunkDirectory = chunksPath;
          created.systemChunks = audioDelegate.systemChunks;
          created.firstAudioTime = audioDelegate.firstAudioTime;
          created.audioQueue = audioDelegate.audioQueue;
          // Keep the output delegate alive for the stream's lifetime.
          created.stream = stream;
          objc_setAssociatedObject(created, @"audioDelegate", audioDelegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        [startupLock unlock];
        dispatch_semaphore_signal(semaphore);
      }];
    }];

    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)) != 0) {
      [startupLock lock]; cancelled = YES; MochiCaptureSession *lateSession = created; [startupLock unlock];
      if (lateSession) [lateSession.stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {}];
      MochiWriteError(@"macOS did not start meeting capture within 20 seconds.", errorBuffer, errorCapacity);
      return false;
    }
    if (created == nil) {
      MochiWriteError(failure ?: @"macOS could not start meeting capture.", errorBuffer, errorCapacity);
      return false;
    }
    // Stream startup is not confirmation that the file recorder started.
    if (![created.recordingDelegate waitForRecording:NO timeout:10]) {
      [created.stream stopCaptureWithCompletionHandler:^(__unused NSError *error) {}];
      MochiWriteError([created.recordingDelegate failureMessage] ?: @"macOS started capture but did not start writing the recording.", errorBuffer, errorCapacity);
      return false;
    }
    [MochiCaptureLock() lock];
    activeCapture = created;
    [MochiCaptureLock() unlock];
    return true;
  }
  MochiWriteError(@"Meeting capture requires macOS 15 or later.", errorBuffer, errorCapacity);
  return false;
}

bool mochi_capture_stop(char *errorBuffer, int32_t errorCapacity) {
  if (@available(macOS 15.0, *)) {
    [MochiCaptureLock() lock];
    MochiCaptureSession *session = activeCapture;
    [MochiCaptureLock() unlock];
    if (session == nil) {
      MochiWriteError(@"No meeting recording is active.", errorBuffer, errorCapacity);
      return false;
    }

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSString *failure = nil;
    [session.stream stopCaptureWithCompletionHandler:^(NSError *stopError) {
      failure = stopError.localizedDescription;
      dispatch_semaphore_signal(semaphore);
    }];
    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)) != 0) {
      if (![session.recordingDelegate isRecording]) {
        [session finishLiveChunks];
        [MochiCaptureLock() lock]; if (activeCapture == session) activeCapture = nil; [MochiCaptureLock() unlock];
      }
      MochiWriteError(@"macOS did not stop capture within 20 seconds. Try Stop again.", errorBuffer, errorCapacity);
      return false;
    }
    // The stream completion can precede the file writer completion.
    BOOL finished = [session.recordingDelegate waitForRecording:YES timeout:15];
    if (!finished) {
      NSString *detail = [session.recordingDelegate failureMessage] ?: failure ?: @"macOS did not confirm that the recording file was finalized.";
      [session finishLiveChunks];
      [MochiCaptureLock() lock]; activeCapture = nil; [MochiCaptureLock() unlock];
      MochiWriteError(detail, errorBuffer, errorCapacity);
      return false;
    }
    [session finishLiveChunks];
    [MochiCaptureLock() lock];
    activeCapture = nil;
    [MochiCaptureLock() unlock];
    return true;
  }
  MochiWriteError(@"Meeting capture requires macOS 15 or later.", errorBuffer, errorCapacity);
  return false;
}

bool mochi_capture_is_active(void) {
  [MochiCaptureLock() lock];
  BOOL active = [activeCapture.recordingDelegate isRecording];
  [MochiCaptureLock() unlock];
  return active;
}

void mochi_capture_last_error(char *errorBuffer, int32_t errorCapacity) {
  [MochiCaptureLock() lock];
  NSString *failure = [activeCapture.recordingDelegate failureMessage];
  [MochiCaptureLock() unlock];
  MochiWriteError(failure ?: @"The recording stream stopped unexpectedly.", errorBuffer, errorCapacity);
}

int64_t mochi_capture_duration_seconds(void) {
  [MochiCaptureLock() lock];
  NSDate *startedAt = activeCapture.startedAt;
  [MochiCaptureLock() unlock];
  return startedAt == nil ? 0 : (int64_t)-startedAt.timeIntervalSinceNow;
}

int64_t mochi_capture_file_bytes(void) {
  if (@available(macOS 15.0, *)) {
    [MochiCaptureLock() lock];
    NSInteger size = activeCapture.output.recordedFileSize;
    [MochiCaptureLock() unlock];
    return (int64_t)MAX(size, 0);
  }
  return 0;
}
