export function foregroundAllowed(input = {}) {
  return input?.allowForeground === true;
}

export async function bringToFrontIfAllowed(page, input = {}) {
  if (!foregroundAllowed(input) || typeof page?.bringToFront !== "function") return false;
  await page.bringToFront().catch(() => undefined);
  return true;
}
