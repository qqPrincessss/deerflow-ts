/**
 * 沙箱相关异常。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/exceptions.py
 */

export class SandboxError extends Error {
    public details: Record<string, unknown>;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = "SandboxError";
        this.details = details ?? {};

        let detailStr = "";
        if (this.details) {
            detailStr = Object.entries(this.details)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ");
        }
        this.message = detailStr ? `${message} (${detailStr})` : message;
    }
}

export class SandboxNotFoundError extends SandboxError {
    public sandboxId?: string;

    constructor(message: string = "Sandbox not found", sandboxId?: string) {
        const details = sandboxId ? { sandbox_id: sandboxId } : undefined;
        super(message, details);
        this.name = "SandboxNotFoundError";
        this.sandboxId = sandboxId;
    }
}

export class SandboxRuntimeError extends SandboxError {
    constructor(message: string = "Sandbox runtime error") {
        super(message);
        this.name = "SandboxRuntimeError";
    }
}

export class SandboxCommandError extends SandboxError {
    public command?: string;
    public exitCode?: number;

    constructor(message: string, command?: string, exitCode?: number) {
        const details: Record<string, unknown> = {};
        if (command) {
            details.command = command.length > 100 ? command.slice(0, 100) + "..." : command;
        }
        if (exitCode !== undefined) {
            details.exit_code = exitCode;
        }
        super(message, details);
        this.name = "SandboxCommandError";
        this.command = command;
        this.exitCode = exitCode;
    }
}

export class SandboxFileError extends SandboxError {
    public path?: string;
    public operation?: string;

    constructor(message: string, path?: string, operation?: string) {
        const details: Record<string, unknown> = {};
        if (path) details.path = path;
        if (operation) details.operation = operation;
        super(message, details);
        this.name = "SandboxFileError";
        this.path = path;
        this.operation = operation;
    }
}

export class SandboxPermissionError extends SandboxFileError {
    constructor(message: string = "Permission denied", path?: string, operation?: string) {
        super(message, path, operation);
        this.name = "SandboxPermissionError";
    }
}

export class SandboxFileNotFoundError extends SandboxFileError {
    constructor(message: string = "File not found", path?: string, operation?: string) {
        super(message, path, operation);
        this.name = "SandboxFileNotFoundError";
    }
}
