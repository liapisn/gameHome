/**
 * Storage layout (bucket `property-media`), shared by client uploads and server checks:
 *   org/<org>/property/<property>/photos/<uuid>.webp
 *   org/<org>/property/<property>/photos/thumbs/<uuid>.webp
 *   org/<org>/property/<property>/floorplans/<uuid>.webp
 */
export const MEDIA_BUCKET = "property-media";
export const MAX_PHOTOS_PER_PROPERTY = 120;

export function propertyPrefix(orgId: string, propertyId: string) {
  return `org/${orgId}/property/${propertyId}/`;
}

export function photoPath(orgId: string, propertyId: string, fileId: string) {
  return `${propertyPrefix(orgId, propertyId)}photos/${fileId}.webp`;
}

export function thumbPathFor(photoStoragePath: string) {
  const i = photoStoragePath.lastIndexOf("/");
  return `${photoStoragePath.slice(0, i)}/thumbs/${photoStoragePath.slice(i + 1)}`;
}

export function floorplanPath(orgId: string, propertyId: string, fileId: string) {
  return `${propertyPrefix(orgId, propertyId)}floorplans/${fileId}.webp`;
}
