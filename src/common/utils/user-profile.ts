// Carry the public author already shown in the list into the profile header.
export function userProfileOptions(mid: number | undefined, name?: string, face?: string) {
  return { state: { profileOwner: mid && name ? { mid, name, face: face || "" } : undefined } };
}
