export interface InspectionDisplayMetadata {
  imageType?: "overview" | "detail" | "required_detail" | "standard";
  parentBaselineId?: string | null;
  detailSubject?: string | null;
}

export interface InspectionDisplayTarget {
  label?: string | null;
  roomName?: string | null;
  metadata?: InspectionDisplayMetadata | null;
}

const GENERIC_NUMBERED_LABEL_RE =
  /^(?:view|angle|area|shot|photo|image|picture|frame)\s+(\d+)$/i;
const GENERIC_TYPED_LABEL_RE =
  /^(?:room overview|overview|detail(?: view)?|close[- ]?up(?: check)?)(?:\s+(\d+))?$/i;

function cleanLabelText(value?: string | null): string {
  return (value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function stripRoomNamePrefix(label: string, roomName?: string | null): string {
  const cleanedLabel = cleanLabelText(label);
  const cleanedRoom = cleanLabelText(roomName);
  if (!cleanedLabel || !cleanedRoom) return cleanedLabel;

  const labelLower = cleanedLabel.toLowerCase();
  const roomLower = cleanedRoom.toLowerCase();

  for (const sep of [" - ", ": ", " – ", " "]) {
    const prefix = `${roomLower}${sep}`;
    if (labelLower.startsWith(prefix)) {
      return cleanedLabel.slice(prefix.length).trim();
    }
  }

  if (labelLower.startsWith(roomLower)) {
    return cleanedLabel.slice(cleanedRoom.length).trim();
  }

  return cleanedLabel;
}

function formatGenericLabel(
  imageType: InspectionDisplayMetadata["imageType"],
  viewNumber?: string,
): string {
  const suffix = viewNumber ? ` ${viewNumber}` : "";
  if (imageType === "overview") return `Wide view${suffix}`;
  if (imageType === "required_detail") return `Close-up${suffix}`;
  if (imageType === "detail") return `Detail${suffix}`;
  return viewNumber ? `Spot ${viewNumber}` : "Spot to check";
}

function getGenericLabelMatch(label: string): RegExpMatchArray | null {
  return (
    label.match(GENERIC_NUMBERED_LABEL_RE) ||
    label.match(GENERIC_TYPED_LABEL_RE)
  );
}

export function getInspectionDisplayLabel(
  target: InspectionDisplayTarget,
  fallbackIndex?: number,
): string {
  const roomName = cleanLabelText(target.roomName);
  const cleanedLabel = cleanLabelText(target.label);
  const shortenedLabel = stripRoomNamePrefix(cleanedLabel, roomName);
  const genericMatch = getGenericLabelMatch(shortenedLabel) || getGenericLabelMatch(cleanedLabel);

  const isSpecificShortLabel =
    !!shortenedLabel &&
    !getGenericLabelMatch(shortenedLabel) &&
    shortenedLabel.toLowerCase() !== roomName.toLowerCase();

  if (isSpecificShortLabel) {
    return sentenceCase(shortenedLabel);
  }

  const detailSubject = cleanLabelText(target.metadata?.detailSubject);
  if (detailSubject) {
    return sentenceCase(detailSubject);
  }

  if (genericMatch) {
    return formatGenericLabel(target.metadata?.imageType, genericMatch[1]);
  }

  if (shortenedLabel) {
    return sentenceCase(shortenedLabel);
  }

  if (fallbackIndex !== undefined) {
    return formatGenericLabel(target.metadata?.imageType, String(fallbackIndex + 1));
  }

  return formatGenericLabel(target.metadata?.imageType);
}
