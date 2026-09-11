import type { ClientId, RoomType } from "@home-measure/domain";

import type { LocalChecklistItem, LocalRoom } from "../../local";

export interface ChecklistDefinition {
  label: string;
  category: LocalChecklistItem["category"];
  required: boolean;
}

const definitionsByRoomType: Readonly<Record<RoomType, readonly ChecklistDefinition[]>> = {
  entrance: [
    { label: "현관문 폭", category: "door", required: true },
    { label: "현관문 높이", category: "door", required: true },
    { label: "문 열림 방향", category: "door", required: true },
    { label: "현관 최소 통과 폭", category: "dimension", required: true },
    { label: "문턱 높이", category: "dimension", required: false },
  ],
  living_room: [
    { label: "공간 가로", category: "dimension", required: true },
    { label: "공간 세로", category: "dimension", required: true },
    { label: "천장 높이", category: "dimension", required: true },
    { label: "창문", category: "window", required: false },
    { label: "콘센트", category: "utility", required: false },
    { label: "LAN 포트", category: "utility", required: false },
  ],
  bedroom: [
    { label: "공간 가로", category: "dimension", required: true },
    { label: "공간 세로", category: "dimension", required: true },
    { label: "천장 높이", category: "dimension", required: true },
    { label: "창문", category: "window", required: false },
    { label: "콘센트", category: "utility", required: false },
    { label: "LAN 포트", category: "utility", required: false },
  ],
  kitchen: [
    { label: "냉장고 공간 가로", category: "dimension", required: true },
    { label: "냉장고 공간 깊이", category: "dimension", required: true },
    { label: "냉장고 공간 높이", category: "dimension", required: true },
    { label: "상판 가로", category: "dimension", required: false },
    { label: "상판 깊이", category: "dimension", required: false },
    { label: "콘센트", category: "utility", required: true },
    { label: "수도·배수", category: "utility", required: true },
    { label: "쿡탑", category: "utility", required: false },
  ],
  balcony: [
    { label: "베란다 출입문 폭", category: "door", required: true },
    { label: "세탁기 공간 가로", category: "dimension", required: true },
    { label: "세탁기 공간 깊이", category: "dimension", required: true },
    { label: "세탁기 공간 높이", category: "dimension", required: true },
    { label: "수도", category: "utility", required: true },
    { label: "온수·냉수 가능 여부", category: "utility", required: false },
    { label: "배수구", category: "utility", required: true },
    { label: "콘센트", category: "utility", required: true },
    { label: "실외기 공간", category: "dimension", required: false },
  ],
  bathroom: [
    { label: "문 열림 간섭", category: "door", required: true },
    { label: "변기 공간", category: "dimension", required: false },
    { label: "세면대 공간", category: "dimension", required: false },
    { label: "샤워 공간", category: "dimension", required: true },
    { label: "배수구", category: "utility", required: true },
    { label: "콘센트", category: "utility", required: false },
    { label: "환기", category: "utility", required: true },
  ],
  other: [
    { label: "공간 가로", category: "dimension", required: true },
    { label: "공간 세로", category: "dimension", required: true },
  ],
};

export function checklistDefinitionsFor(roomType: RoomType): readonly ChecklistDefinition[] {
  return definitionsByRoomType[roomType];
}

export function createChecklistDefaults(room: LocalRoom): LocalChecklistItem[] {
  const timestamp = Date.now();
  return checklistDefinitionsFor(room.type).map((definition, sortOrder) => ({
    id: newClientId("checklist"),
    propertyId: room.propertyId,
    roomId: room.id,
    elementId: null,
    label: definition.label,
    category: definition.category,
    required: definition.required,
    status: "pending",
    measurementId: null,
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
    dirty: false,
  }));
}

export function newClientId(prefix: string): ClientId {
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${entropy}` as ClientId;
}

