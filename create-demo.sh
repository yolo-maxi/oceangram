#!/bin/bash

# Oceangram Demo GIF Generator
# Creates a 15-second demo GIF from static frames showing key features

set -e

echo "🪸 Creating Oceangram demo GIF..."

# Create temp directory for frames
TEMP_DIR="/tmp/oceangram-demo"
mkdir -p "$TEMP_DIR"

# Copy assets we need
cp packages/tray/src/assets/icon.png "$TEMP_DIR/" 2>/dev/null || true
cp logo.png "$TEMP_DIR/" 2>/dev/null || true

# Frame dimensions (800x500 as recommended)
WIDTH=800
HEIGHT=500
FPS=1  # 1 frame per second for 15 frames = 15 seconds

# Generate frames using ImageMagick
echo "Generating frames..."

# Frame 1: Title screen with logo
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 48 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-100 "🪸 Oceangram" \
        -pointsize 24 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-50 "Telegram, everywhere." \
        -pointsize 16 -fill "#64748b" \
        -annotate +0+50 "One daemon, multiple surfaces" \
        "$TEMP_DIR/frame_001.png"

# Frame 2: Architecture overview
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "Universal Architecture" \
        -pointsize 14 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate -200-50 "Tray App" \
        -annotate +0-50 "Oceangram Daemon" \
        -annotate +200-50 "VS Code Extension" \
        -annotate +0+50 "localhost:7777" \
        -annotate +0+100 "HTTP + WebSocket" \
        "$TEMP_DIR/frame_002.png"

# Frame 3: VS Code Extension feature
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "💻 VS Code Integration" \
        -pointsize 16 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-80 "Native Telegram panel in VS Code/Cursor" \
        -annotate +0-50 "AI agent integration" \
        -annotate +0-20 "Seamless code sharing" \
        -annotate +0+20 "Terminal output capture" \
        "$TEMP_DIR/frame_003.png"

# Frame 4: Tray App feature
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "📱 Menu Bar Tray" \
        -pointsize 16 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-80 "Ultra-minimal macOS tray popup" \
        -annotate +0-50 "Whitelisted contacts as tabs" \
        -annotate +0-20 "Smart chat filtering" \
        -annotate +0+20 "Instant message access" \
        "$TEMP_DIR/frame_004.png"

# Frame 5: API Coverage
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "⚡ 100+ API Methods" \
        -pointsize 16 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-80 "Complete Telegram feature set" \
        -annotate +0-50 "Messaging, media, groups" \
        -annotate +0-20 "Admin tools, scheduling" \
        -annotate +0+20 "Real-time WebSocket events" \
        "$TEMP_DIR/frame_005.png"

# Frame 6: AI Agent Integration
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "🤖 AI Agent Cockpit" \
        -pointsize 16 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-80 "OpenClaw integration" \
        -annotate +0-50 "Chat management & kanban boards" \
        -annotate +0-20 "Resource tracking" \
        -annotate +0+20 "Agent status monitoring" \
        "$TEMP_DIR/frame_006.png"

# Frame 7: Privacy emphasis
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "🔒 Privacy First" \
        -pointsize 16 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-80 "Your session never leaves your machine" \
        -annotate +0-50 "No cloud, no third-party servers" \
        -annotate +0-20 "Local storage in ~/.oceangram/" \
        -annotate +0+20 "OpenClaw integration is optional" \
        "$TEMP_DIR/frame_007.png"

# Frame 8: Tech Stack
convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
        -gravity center \
        -pointsize 32 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
        -annotate +0-150 "🛠️ Tech Stack" \
        -pointsize 16 -fill "#64748b" -font "DejaVu-Sans" \
        -annotate +0-80 "TypeScript • gramjs • Fastify" \
        -annotate +0-50 "Electron • esbuild • pnpm" \
        -annotate +0-20 "MTProto • WebSocket • HTTP" \
        "$TEMP_DIR/frame_008.png"

# Frame 9-15: Hold on final frame with call to action
for i in {009..015}; do
    convert -size ${WIDTH}x${HEIGHT} xc:"#f8fafc" \
            -gravity center \
            -pointsize 36 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
            -annotate +0-100 "🪸 Get Started" \
            -pointsize 18 -fill "#2563eb" -font "DejaVu-Sans" \
            -annotate +0-40 "Download VS Code Extension" \
            -pointsize 18 -fill "#2563eb" \
            -annotate +0-10 "Clone for macOS Tray App" \
            -pointsize 14 -fill "#64748b" \
            -annotate +0+40 "github.com/oceangram/oceangram" \
            -pointsize 14 -fill "#64748b" \
            -annotate +0+80 "oceangram.repo.box" \
            "$TEMP_DIR/frame_${i}.png"
done

echo "Creating GIF from frames..."

# Create the assets directory if it doesn't exist
mkdir -p packages/website/src/assets

# Create GIF using ffmpeg
ffmpeg -y -f image2 -framerate $FPS -i "$TEMP_DIR/frame_%03d.png" \
       -vf "palettegen" \
       "$TEMP_DIR/palette.png"

ffmpeg -y -f image2 -framerate $FPS -i "$TEMP_DIR/frame_%03d.png" \
       -i "$TEMP_DIR/palette.png" \
       -filter_complex "paletteuse=dither=bayer:bayer_scale=5" \
       -loop 0 \
       "packages/website/src/assets/demo.gif"

echo "✅ Demo GIF created at packages/website/src/assets/demo.gif"

# Clean up
rm -rf "$TEMP_DIR"

echo "🎬 Demo GIF generation complete!"
