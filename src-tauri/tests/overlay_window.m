#import "../src/macos_window.m"
#include <assert.h>

int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 368, 72)
                                                 styleMask:NSWindowStyleMaskBorderless
                                                   backing:NSBackingStoreBuffered defer:NO];
    mochi_position_overlay_window((__bridge void *)window);
    mochi_configure_overlay_window((__bridge void *)window);
    assert(window.isVisible);
    assert(!window.isKeyWindow);
    assert(window.level == NSScreenSaverWindowLevel);
    assert(window.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllApplications);
    assert(window.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces);
    assert(window.collectionBehavior & NSWindowCollectionBehaviorFullScreenAuxiliary);
    assert(!(window.collectionBehavior & NSWindowCollectionBehaviorFullScreenPrimary));
    assert(!window.hidesOnDeactivate);
    [window orderOut:nil];
    printf("Overlay window: visible across Spaces, correct level, and shown without taking keyboard focus.\n");
  }
  return 0;
}
