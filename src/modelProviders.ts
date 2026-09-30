export type ModelApi = "ollama" | "deepseek" | "openai";

export function providerDefaults(api: ModelApi): {baseUrl:string;model:string} {
  if (api === "ollama") return {baseUrl:"http://127.0.0.1:11434",model:"qwen3:4b-instruct"};
  if (api === "deepseek") return {baseUrl:"https://api.deepseek.com",model:"deepseek-flash"};
  return {baseUrl:"",model:""};
}

export function discoveredModel(api: ModelApi, current: string, names: string[]): string {
  if (names.includes(current)) return current;
  if (api === "deepseek") return names.includes("deepseek-flash") ? "deepseek-flash" : names[0] || "";
  if (api === "ollama") return names.includes("qwen3:4b-instruct") ? "qwen3:4b-instruct" : names[0] || "";
  return names.length === 1 ? names[0] : "";
}
