#import <AppKit/AppKit.h>

void mochi_configure_overlay_window(void *windowPointer) {
  if (windowPointer == NULL) return;
  void (^configure)(void) = ^{
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    NSWindowCollectionBehavior behavior = window.collectionBehavior;
    behavior |= NSWindowCollectionBehaviorCanJoinAllSpaces;
    behavior |= NSWindowCollectionBehaviorFullScreenAuxiliary;
    behavior |= NSWindowCollectionBehaviorStationary;
    behavior &= ~(NSWindowCollectionBehaviorPrimary | NSWindowCollectionBehaviorAuxiliary);
    behavior |= NSWindowCollectionBehaviorCanJoinAllApplications;
    behavior &= ~NSWindowCollectionBehaviorFullScreenPrimary;
    window.collectionBehavior = behavior;
    window.level = NSScreenSaverWindowLevel;
    window.hidesOnDeactivate = NO;
    [window orderFrontRegardless];
  };
  if (NSThread.isMainThread) configure();
  else dispatch_sync(dispatch_get_main_queue(), configure);
}

void mochi_position_overlay_window(void *windowPointer) {
  if (windowPointer == NULL) return;
  void (^position)(void) = ^{
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    NSScreen *screen = NSScreen.mainScreen;
    for (NSScreen *candidate in NSScreen.screens) {
      if (NSPointInRect(NSEvent.mouseLocation, candidate.frame)) { screen = candidate; break; }
    }
    NSRect frame = screen.visibleFrame;
    [window setFrameOrigin:NSMakePoint(NSMidX(frame) - window.frame.size.width / 2,
                                      NSMaxY(frame) - window.frame.size.height - 12)];
  };
  if (NSThread.isMainThread) position();
  else dispatch_sync(dispatch_get_main_queue(), position);
}
