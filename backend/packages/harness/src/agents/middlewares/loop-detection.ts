const recentCalls:string[] = [];
const MAX_REPEATED = 3;

export function checkLoop(toolName:string,args:string):boolean{
    const key = toolName + args;
    let count = 0;
    for(let i = 0;i<recentCalls.length;i++){
        if(recentCalls[i] === key){
            count++;
        }
    }
    recentCalls.push(key);
    if(count >=MAX_REPEATED){
        return true;
    }
    return false;
}