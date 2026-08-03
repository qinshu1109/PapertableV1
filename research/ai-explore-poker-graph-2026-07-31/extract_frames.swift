import AppKit
import AVFoundation
import Foundation

guard CommandLine.arguments.count == 7 else {
    fputs("usage: extract_frames.swift INPUT OUTPUT_DIR START DURATION STEP PREFIX\n", stderr)
    exit(2)
}

let input = URL(fileURLWithPath: CommandLine.arguments[1])
let outputDir = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let start = Double(CommandLine.arguments[3])!
let requestedDuration = Double(CommandLine.arguments[4])!
let step = Double(CommandLine.arguments[5])!
let prefix = CommandLine.arguments[6]

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: input)
guard let track = asset.tracks(withMediaType: .video).first else {
    fputs("no video track\n", stderr)
    exit(3)
}

let sourceDuration = asset.duration.seconds
let end = min(sourceDuration, start + requestedDuration)
let transformedSize = track.naturalSize.applying(track.preferredTransform)
let width = Int(abs(transformedSize.width).rounded())
let height = Int(abs(transformedSize.height).rounded())

print(String(format: "duration=%.6f fps=%.3f width=%d height=%d", sourceDuration, track.nominalFrameRate, width, height))

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

var index = 0
var requested = start
while requested <= end + 0.000_001 {
    var actual = CMTime.zero
    do {
        let image = try generator.copyCGImage(
            at: CMTime(seconds: requested, preferredTimescale: 60_000),
            actualTime: &actual
        )
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "extract_frames", code: 1)
        }
        let name = String(
            format: "%@-%04d-requested-%07.3f-actual-%07.3f.png",
            prefix,
            index,
            requested,
            actual.seconds
        )
        try data.write(to: outputDir.appendingPathComponent(name))
        print(name)
    } catch {
        fputs(String(format: "frame failed requested=%.6f: %@\n", requested, String(describing: error)), stderr)
    }
    index += 1
    requested = start + Double(index) * step
}
