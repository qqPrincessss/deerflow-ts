export interface SandboxState {
    sandbox_id?: string | null;
}

export interface ThreadDataState {
    workspace_path?: string;
    uploads_path?: string;
    outputs_path?: string;
}

export function mergeArtifacts(old: string[], newItems: string[]): string[] {
    let res = [];
    res = old.concat(newItems);
    return [...new Set(res)];
}

export function mergeTitle(old: string | null, newTitle: string | null): string | null {
    if (newTitle === null) return old;
    return newTitle;
}
