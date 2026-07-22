/**
 * 宿主路径 → 虚拟路径的输出掩码正则。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/path_patterns.py
 *
 * 两个独立调用点将宿主路径改写回虚拟形式，输出给模型：
 * 1. LocalSandbox._reverse_output_patterns（bash 输出）
 * 2. sandbox.tools._compiled_mask_patterns（glob/grep/ls 结果）
 *
 * 它们必须对"宿主基路径允许在哪结束"达成一致，因为两者都送入相同
 * 的下游契约——如果一个匹配在真正的段边界前停止，改写后的容器路径
 * 在正向解析时会无法映射回来。
 *
 * 以前每个文件各保留一份规则，导致 #4035 给反向模式加了段边界，
 * 但遗漏了掩码模式，#4053 又得给另一份加同样的边界。
 * 这个模块只保留一份规则，杜绝第三份悄悄跑偏的可能。
 */

// 段边界：只匹配宿主基路径在真实路径段边界结束的位置。
// 这样挂载根不会匹配到仅仅是共享前缀的兄弟（如 ".../skills" 不会匹配到 ".../skills-extra"）。
// 这个类是面向文本的，不是面向 shell 的（对比 LocalSandbox._command_pattern）：
// 两个调用者都在任意命令输出或文件列表上运行，根路径后面可以跟 `,` `:` 或 `\`，
// 而面向 shell 的类会拒绝这些。
// `$` 是负载关键的：输出正好在挂载根结束时，如果不带上 $ 前瞻会失败，
// 导致原始宿主路径被直接发射出去。
const _SEGMENT_BOUNDARY = "(?=/|$|[^\\w./-])";

// 基路径后面的路径尾部。[/\\] 保持 Windows 分隔的路径也能匹配；
// 排除类在空白和 shell 标点处停止，这样嵌入到更大行中的路径不会被过度消费。
const _PATH_TAIL = "(?:[/\\\\][^\\s\"';&|<>()]*)?";

/**
 * 构建一个宿主基路径的输出掩码匹配器。
 *
 * @param base 宿主路径根（已由调用者解析）
 * @param separatorAgnostic 是否接受基路径内部两种分隔符，
 *   因此用 `\\` 捕获的基路径仍然能匹配用 `/` 书写相同路径的输出。
 *   sandbox.tools 需要这个，因为它从 _path_variants 派生基路径（产生 Windows 风格拼写），
 *   并在它无法控制分隔符的输出上匹配它们。
 *   LocalSandbox 不需要：它的基路径来自 Path.resolve()，已经携带运行平台的分隔符，
 *   放宽它们会扩大它的掩码范围。
 * @returns 编译后的正则模式，在段边界匹配 base，加上可选的路径尾部
 */
export function buildOutputMaskPattern(base: string, separatorAgnostic: boolean = false): RegExp {
    let escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (separatorAgnostic) {
        escaped = escaped.replace(/\\\\/g, "[/\\\\]");
    }
    return new RegExp(escaped + _SEGMENT_BOUNDARY + _PATH_TAIL, "g");
}
