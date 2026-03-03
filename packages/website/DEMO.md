# Demo GIF Creation

## Current Status
- ✅ 15-second demo GIF created at `packages/website/src/assets/demo.gif`
- ✅ Website updated to reference demo.gif
- ✅ README updated with demo section

## Specifications
- **Dimensions**: 800x500px (as recommended)
- **Duration**: 15 seconds (1 fps = 15 frames)
- **Size**: ~85KB optimized GIF
- **Format**: Static frames showing key features

## Manual Recording (Future Enhancement)

For a real demo recording from a running Oceangram instance:

1. **Setup**: Launch VS Code with extension + Tray app
2. **Record**: 15-second screen capture showing:
   - Tray app popup with contacts
   - VS Code extension panel with chat
   - Sending messages between surfaces
   - AI agent integration (if enabled)
3. **Process**: Convert to 800x500 GIF using ffmpeg
4. **Replace**: Update `packages/website/src/assets/demo.gif`

## Current Demo Content
The current GIF showcases through static frames:
- Title screen with Oceangram branding
- Universal architecture overview
- VS Code integration features
- Tray app capabilities
- 100+ API methods
- AI agent cockpit
- Privacy-first approach
- Tech stack overview
- Call to action

This provides a comprehensive feature overview until live recording is possible.
