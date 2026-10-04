import { Bot } from "@/lib/platform-icons";

const brands: Record<string, string> = {
  nvidia: "nvidia", openai: "openai", anthropic: "anthropic", meta: "meta",
  google: "google", deepseek: "deepseek", qwen: "qwen", mistral: "mistral",
  openrouter: "openrouter", groq: "groq", cohere: "cohere", xai: "xai",
  "01.ai": "yi", "ai21 labs": "ai21", microsoft: "microsoft", zhipu: "zhipu",
  "z-ai": "zai", moonshotai: "moonshot", ibm: "ibm", poolside: "poolside",
};

export function ProviderLogo({ provider, size = 24 }: { provider: string; size?: number }) {
  const brand = brands[provider.toLowerCase()];
  if (!brand) return <Bot size={size} aria-label={provider} />;
  return <span role="img" aria-label={provider} className="inline-block shrink-0 bg-current"
    style={{ width: size, height: size, mask: `url(/provider-logos/${brand}.svg) center / contain no-repeat`, WebkitMask: `url(/provider-logos/${brand}.svg) center / contain no-repeat` }} />;
}
