// Configuration constants, presets, and model endpoints for AuraStudio AI

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id"
};

export const DAILY_FREE_GENERATIONS_LIMIT = 5;

// Neutral blank canvas base64 for pure Text-to-Image generation with Qwen 2.1 DiT
export const DEFAULT_BLANK_CANVAS_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA/9k=";

// Modal Multi-Account Failover Endpoints (Auto load-balancing across accounts)
export const MODAL_PHOTO_ENDPOINTS = [
  "https://memory1024--qwen-image-edit-service-qweneditor-api-edit.modal.run",
  "https://dmytrobbch--qwen-image-edit-service-qweneditor-api-edit.modal.run"
];

// Modal Asynchronous Job Endpoints (Decoupled submit & poll bypassing Cloudflare 100s timeout)
export const MODAL_ASYNC_ENDPOINTS = [
  {
    submit: "https://memory1024--qwen-image-edit-service-qweneditor-api-submit.modal.run",
    status: "https://memory1024--qwen-image-edit-service-qweneditor-api-job-status.modal.run"
  }
];

export const MODAL_VIDEO_ENDPOINTS = [
  "https://memory1024--aurastudio-video-l40s-animate-video.modal.run"
];

export const GLOBAL_PRESETS = {
  ultrahd_skin: "enhance to authentic ultra-sharp 8k high resolution master portrait, preserve full portrait composition, preserve full framing, visible delicate natural micro skin pores, delicate natural peach fuzz vellus hair, authentic unretouched skin texture, subtle subcutaneous capillaries, delicate specular sebum reflections, soft cinematic studio lighting, 85mm lens, razor-sharp focus",
  linkedin: "change clothes to a sharp tailored dark navy business suit with crisp white shirt and studio lighting",
  old_money: "change clothes to an elegant Old Money beige cashmere knit sweater and tailored linen trousers",
  charcoal_merino: "change clothes to a finely tailored dark charcoal grey merino wool crewneck sweater with crisp white undershirt collar, clean ribbed cuffs, professional studio key lighting from upper left, subtle specular highlights on cheeks",
  blonde: "change hair color to natural sun-kissed soft blonde with delicate hair strands and realistic highlights",
  bali: "change background to a tropical luxury Bali resort infinity pool with golden hour sunset lighting",
  cyberpunk: "change style to cyberpunk neon noir, futuristic leather jacket with subtle glowing reflections",
  muppet: "stylize clothes and atmosphere into funny Muppet aesthetic with retro yellow overalls and striped vintage shirt, funny whimsical felt textures, cinematic lighting",
  goofy3d: "stylize clothing and atmosphere into bright 3D animated character aesthetic, colorful stylized studio background",
  retro90s: "change style and attire to unhinged 90s vintage clothing, nostalgic 90s disposable camera aesthetic, flash photography"
};

// Protected Standards (Rule 6: Mandatory Golden Identity Retention Formula)
export const IDENTITY_ANCHOR_SUFFIX = "keep exact same person, 100% exact original face, exact same camera distance, preserve full original portrait framing from head to torso, no cropping, no zoom-in, no macro zoom, sharp focused eyes and gaze, exact original lips and expression, preserve original lighting, exact original skin color and tone, authentic natural micro skin pores, gentle subsurface scattering, clean jawline and neck, razor-sharp focused eyes with natural catchlights, raw 35mm dslr portrait photography, seamless photorealistic integration, no text";

export function anchorPromptForPhoto(promptText) {
  if (!promptText) return IDENTITY_ANCHOR_SUFFIX;
  const clean = promptText.trim();
  if (clean.toLowerCase().includes("keep exact same person")) return clean;
  return `${clean}, ${IDENTITY_ANCHOR_SUFFIX}`;
}
