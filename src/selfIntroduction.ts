/** Match a direct request, never a question about how to write an introduction. */
export function isSelfIntroductionRequest(text:string):boolean{
  const chinese=text.trim().replace(/[\s，,。.!！?？:：、]/g,"");
  const prefix="(?:(?:你好|您好|好的|好|那么|现在|接下来|首先|开始之前|面试开始前))*(?:请|麻烦|能否|能不能|可以|可否)?(?:你|您)?(?:先)?(?:给(?:我|我们))?";
  const suffix="(?:一下)?(?:好吗|可以吗|吗|吧)?";
  if(new RegExp(`^${prefix}(?:做|来|进行)?(?:一(?:个|下|段)|个)?(?:简单的?|简短的?|简要的?)?自我介绍${suffix}$`).test(chinese))return true;
  if(new RegExp(`^${prefix}(?:简单|简短|简要)?介绍(?:一下)?(?:你|您)?自己${suffix}$`).test(chinese))return true;
  return /^(?:(?:please|could you|can you|would you)\s+)?(?:briefly\s+)?(?:introduce yourself|(?:give|do)\s+(?:a\s+)?(?:brief\s+|short\s+)?self[- ]introduction)(?:\s+please)?[.!?]?$/i.test(text.trim());
}
