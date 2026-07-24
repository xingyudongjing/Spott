import SwiftUI

enum SpottMotion {
    static let quick: Animation = .snappy(duration: 0.12, extraBounce: 0)
    static let standard: Animation = .smooth(duration: 0.22)
    static let emphatic: Animation = .spring(duration: 0.36, bounce: 0.24)
}

private struct SpottPressableModifier: ViewModifier {
    let scale: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var isPressed = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPressed && !reduceMotion ? scale : 1)
            .animation(reduceMotion ? nil : SpottMotion.quick, value: isPressed)
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .updating($isPressed) { _, state, _ in
                        state = true
                    }
            )
    }
}

extension View {
    func spottPressable(scale: CGFloat = 0.96) -> some View {
        modifier(SpottPressableModifier(scale: scale))
    }
}

#Preview("Pressable card") {
    ZStack {
        SpottScreenBackground()
        SurfaceCard {
            VStack(alignment: .leading, spacing: 6) {
                Text("按住试试")
                    .font(.headline)
                Text("卡片会以 120ms 快速曲线轻微缩放。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .spottPressable()
        .padding(SpottMetric.pageInset)
    }
}
