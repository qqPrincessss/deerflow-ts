import { z } from "zod";

export const ModelConfigSchema = z.object({
    name: z.string(),
    use: z.string(),
    api_key: z.string().optional(),
    model: z.string()
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export function resolveConfigValue(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.startsWith("$")) return process.env[value.slice(1)];
    return value;
}
