/**
 * 动态模块加载工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/reflection/resolvers.py
 *
 * 场景：config.yaml 里写 use: "langchain_openai:ChatOpenAI"，
 * 系统要根据这个字符串动态加载对应的类。
 */

/** 模块名到 npm 包名的映射（用于错误提示） */
const MODULE_TO_PACKAGE_HINTS: Record<string, string> = {
    langchain_openai: "@langchain/openai",
    langchain_anthropic: "@langchain/anthropic",
    langchain_google_genai: "@langchain/google-genai",
    langchain_deepseek: "@langchain/deepseek",
};

/**
 * 构建缺失依赖提示。
 */
function _buildMissingDependencyHint(modulePath: string, err: Error): string {
    const moduleRoot = modulePath.split(".")[0];
    const missingModule = (err as NodeJS.ErrnoException).code || moduleRoot;
    const packageName = MODULE_TO_PACKAGE_HINTS[moduleRoot] || MODULE_TO_PACKAGE_HINTS[missingModule] || missingModule.replace(/_/g, "-");
    return `Missing dependency '${missingModule}'. Install it with \`npm install ${packageName}\`, then restart.`;
}

/**
 * 从路径解析变量。
 *
 * @param variablePath 变量路径（如 "langchain_openai:ChatOpenAI"）
 * @returns 解析后的变量
 */
export async function resolveVariable(variablePath: string): Promise<unknown> {
    const colonIndex = variablePath.lastIndexOf(":");
    if (colonIndex === -1) {
        throw new Error(`Invalid variable path: ${variablePath}. Expected format: module:variable`);
    }

    const modulePath = variablePath.slice(0, colonIndex);
    const variableName = variablePath.slice(colonIndex + 1);

    if (!modulePath || !variableName) {
        throw new Error(`Invalid variable path: ${variablePath}. Expected format: module:variable`);
    }

    let module: Record<string, unknown>;
    try {
        module = await import(modulePath);
    } catch (err) {
        const hint = _buildMissingDependencyHint(modulePath, err as Error);
        throw new Error(`Could not import module ${modulePath}. ${hint}`);
    }

    const variable = module[variableName];
    if (variable === undefined) {
        throw new Error(`Module ${modulePath} does not export ${variableName}`);
    }

    return variable;
}

/**
 * 从路径解析类。
 *
 * @param classPath 类路径（如 "langchain_openai:ChatOpenAI"）
 * @returns 解析后的类
 */
export async function resolveClass(classPath: string): Promise<new (...args: unknown[]) => unknown> {
    const cls = await resolveVariable(classPath);

    if (typeof cls !== "function") {
        throw new Error(`${classPath} is not a valid class`);
    }

    return cls as new (...args: unknown[]) => unknown;
}
