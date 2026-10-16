export const TRASH_DROP_EVENT = 'cloudvault:trash-drop';
export const PERSONAL_DRAG_TYPE = 'application/x-cloudvault-item';
export const PROJECT_DRAG_TYPE = 'application/x-cloudvault-project-item';

export type TrashDropPayload = {
  scope: 'personal' | 'project';
  type: 'file' | 'folder';
  id: string;
  projectId?: string;
};

declare global {
  interface Window {
    __cloudvaultTrashDragPayload?: TrashDropPayload;
  }
}

export function beginTrashDrag(payload: TrashDropPayload) {
  window.__cloudvaultTrashDragPayload = payload;
}

export function endTrashDrag() {
  delete window.__cloudvaultTrashDragPayload;
}

export function readTrashDropPayload(dataTransfer: DataTransfer): TrashDropPayload | null {
  const transferType = dataTransfer.types.includes(PERSONAL_DRAG_TYPE)
    ? PERSONAL_DRAG_TYPE
    : dataTransfer.types.includes(PROJECT_DRAG_TYPE)
      ? PROJECT_DRAG_TYPE
      : null;
  if (transferType) {
    try {
      const payload = dataTransfer.getData(transferType);
      if (payload) return JSON.parse(payload) as TrashDropPayload;
    } catch {
      // Some browsers expose the custom MIME type during dragover but withhold
      // its value until drop. Fall back to the same-window drag session below.
    }
  }
  return window.__cloudvaultTrashDragPayload ?? null;
}
