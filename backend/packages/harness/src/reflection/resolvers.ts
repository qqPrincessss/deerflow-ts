const MODULE_TO_PACKAGE_HINTS: Record<string, string> = {
    langchain_openai: "@langchain/openai",
    langchain_anthropic: "@langchain/anthropic",
    langchain_google_genai: "@langchain/google-genai",
};
export async function resolveVariable(variablePath: string): Promise<unknown> {
    // 解析路径： "langchain_openai:ChatOpenAI" → ["langchain_openai", "ChatOpenAI"]
    const [modulePath, variableName] = variablePath.split(":");
    if (!modulePath || !variableName) {
        throw new Error(`Invalid variable path: ${variablePath}. Expected format:
  module:variable`);
    }

    // 动态导入模块
    const module = await import(modulePath);

    // 取出变量
    const variable = module[variableName];
    if (variable === undefined) {
        throw new Error(`Module ${modulePath} does not export ${variableName}`);
    }

    return variable;
}

export async function resolveClass(classPath: string): Promise<new (...args: any[]) =>
    any> {
    const cls = await resolveVariable(classPath);
    if (typeof cls !== "function") {
        throw new Error(`${classPath} is not a valid class`);
    }
    return cls as new (...args: any[]) => any;
}