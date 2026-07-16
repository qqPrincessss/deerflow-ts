//接受工具名和执行函数
export async function wrapToolCall(
    toolName:string,
    handler:()=>Promise<string>
):Promise<string>{
    try{
        const result = await handler();
        return result;
    }catch(error){
        return `Error: Tool '${toolName}' failed: ${error}`;
    }
}