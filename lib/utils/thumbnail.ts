export function thumbnailUrl(asset: { id: string } | null | undefined) {
  return asset ? `/api/thumbnails/${encodeURIComponent(asset.id)}` : null;
}
