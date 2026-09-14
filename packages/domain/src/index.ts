import { z } from "zod";

export const layoutVersion = 1 as const;

const clientIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** A stable, client-generated identifier used by local-first entities. */
export const clientIdSchema = z
  .string()
  .regex(clientIdentifierPattern, "Expected a stable client-generated ID");

/** Identifies one retryable write produced by a client. */
export const clientMutationIdSchema = z
  .string()
  .regex(clientIdentifierPattern, "Expected a stable client mutation ID");

/**
 * Sign-in credentials. Accounts live in this app's own D1 table, so there is no identity provider
 * to depend on. Usernames are compared in lower case; passwords are never stored in the clear.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/, "Expected 3-32 characters: letters, digits, . _ or -");
export const passwordSchema = z.string().min(10, "Use at least 10 characters").max(200);

export const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
}).strict();

export const millimetersSchema = z.number().finite().int().min(0).max(100_000);
export const positiveMillimetersSchema = millimetersSchema.min(1);
export const timestampSchema = z.number().finite().int().nonnegative();

export const roomTypeSchema = z.enum([
  "entrance",
  "living_room",
  "bedroom",
  "kitchen",
  "bathroom",
  "balcony",
  "other",
]);

/**
 * The four outer walls, plus the two inner walls a corner notch creates. A notched room is an
 * L: doors and windows can sit on the inner walls exactly like on an outer one.
 */
export const wallSchema = z.enum([
  "north",
  "east",
  "south",
  "west",
  "notchHorizontal",
  "notchVertical",
]);
export const roomCornerSchema = z.enum(["northWest", "northEast", "southEast", "southWest"]);
export const hingeSideSchema = z.enum(["left", "right"]);
export const openingDirectionSchema = z.enum(["inward", "outward"]);
export const windowOpeningSchema = z.enum([
  "sliding",
  "casement",
  "fixed",
  "other",
]);
export const utilityTypeSchema = z.enum([
  "outlet",
  "lan",
  "water",
  "drain",
  "gas",
  "boiler",
  "ac",
  "interphone",
]);

export const pointSchema = z.object({
  x: millimetersSchema,
  y: millimetersSchema,
}).strict();

export const doorElementSchema = z.object({
  id: clientIdSchema,
  wall: wallSchema,
  offset: millimetersSchema,
  width: positiveMillimetersSchema,
  /** Opening height above the floor. Absent until someone measures it. */
  height: positiveMillimetersSchema.optional(),
  hinge: hingeSideSchema,
  opening: openingDirectionSchema,
  note: z.string().trim().max(2_000).optional(),
}).strict();

export const windowElementSchema = z.object({
  id: clientIdSchema,
  wall: wallSchema,
  offset: millimetersSchema,
  width: positiveMillimetersSchema,
  height: positiveMillimetersSchema,
  sillHeight: millimetersSchema,
  opening: windowOpeningSchema,
  note: z.string().trim().max(2_000).optional(),
}).strict();

export const elementSizeSchema = z.object({
  width: positiveMillimetersSchema,
  height: positiveMillimetersSchema,
}).strict();

/** Default footprint for a utility drawn without its own measured size. */
export const defaultUtilitySize = { width: 120, height: 120 } as const;

/**
 * Heights used only to draw a wall before anyone has measured it. They are never written to a
 * record: an elevation marks them as unmeasured so a guess is not mistaken for a reading.
 */
export const nominalHeights = {
  ceiling: 2_300,
  door: 2_100,
  utilityFloor: 300,
} as const;

export const utilityElementSchema = z.object({
  id: clientIdSchema,
  type: utilityTypeSchema,
  /** Centre of the footprint, so an older record without a size keeps the same anchor point. */
  position: pointSchema,
  size: elementSizeSchema.optional(),
  /** Height of the bottom edge above the floor, which is what a tape reads on site. */
  floorHeight: millimetersSchema.optional(),
  note: z.string().trim().max(2_000).optional(),
}).strict();

/** A rectangular bite out of one corner, which turns the room into an L. */
export const roomNotchSchema = z.object({
  corner: roomCornerSchema,
  width: positiveMillimetersSchema,
  height: positiveMillimetersSchema,
}).strict();

/**
 * A room is a rectangle, optionally with one corner cut away. Free polygons stay out of scope.
 * Elements are room-local and their IDs remain stable across offline retries.
 */
export const roomLayoutSchema = z.object({
  version: z.literal(layoutVersion),
  position: pointSchema,
  size: z.object({
    width: positiveMillimetersSchema,
    height: positiveMillimetersSchema,
  }).strict(),
  notch: roomNotchSchema.optional(),
  /** Floor-to-ceiling height, needed to draw a wall rather than only the floor plan. */
  ceilingHeight: positiveMillimetersSchema.optional(),
  doors: z.array(doorElementSchema).max(64),
  windows: z.array(windowElementSchema).max(64),
  utilities: z.array(utilityElementSchema).max(128),
}).strict().superRefine((layout, ctx) => {
  const ids = [...layout.doors, ...layout.windows, ...layout.utilities].map(
    (element) => element.id,
  );
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: "custom",
      message: "Element IDs must be unique within a room layout",
      path: ["doors"],
    });
  }
  if (layout.notch && (layout.notch.width >= layout.size.width || layout.notch.height >= layout.size.height)) {
    ctx.addIssue({
      code: "custom",
      message: "A corner notch must leave part of the room behind",
      path: ["notch"],
    });
  }
  const wallLengths = roomWallLengths(layout);
  for (const [collection, elements] of [["doors", layout.doors], ["windows", layout.windows]] as const) {
    elements.forEach((element, index) => {
      const wallLength = wallLengths[element.wall];
      if (element.offset + element.width > wallLength) {
        ctx.addIssue({
          code: "custom",
          message: "Wall element must fit within its attached wall",
          path: [collection, index],
        });
      }
    });
  }
});

/**
 * How long each wall runs. A notch shortens the two outer walls that meet at its corner and
 * creates the two inner walls; without a notch those inner walls do not exist.
 */
export function roomWallLengths(layout: {
  size: { width: number; height: number };
  notch?: { corner: RoomCorner; width: number; height: number } | undefined;
}): Record<Wall, number> {
  const { width, height } = layout.size;
  const notch = layout.notch;
  const cuts = (...corners: RoomCorner[]) => Boolean(notch && corners.includes(notch.corner));
  return {
    north: cuts("northWest", "northEast") ? width - notch!.width : width,
    south: cuts("southWest", "southEast") ? width - notch!.width : width,
    east: cuts("northEast", "southEast") ? height - notch!.height : height,
    west: cuts("northWest", "southWest") ? height - notch!.height : height,
    notchHorizontal: notch?.width ?? 0,
    notchVertical: notch?.height ?? 0,
  };
}

/**
 * Upgrades a stored layout to the current shape, oldest step first. A room drawn months ago on a
 * device that never synced still has to open, so every released shape needs a step here rather than
 * a rewrite of the schema above.
 *
 * Two rules keep this table short:
 * - Add fields as optional and never repurpose a name, so the version does not have to move.
 * - Bump `layoutVersion` only for a change that cannot be expressed that way, and add the step that
 *   converts the previous version in the same commit.
 */
const roomLayoutUpgrades: ReadonlyArray<(layout: Record<string, unknown>) => Record<string, unknown>> = [];

/** Reads a layout written by any released version of the app, or null when it is unrecognisable. */
export function parseRoomLayout(raw: unknown): RoomLayout | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  let layout = raw as Record<string, unknown>;
  const storedVersion = typeof layout.version === "number" ? layout.version : 0;
  for (let version = storedVersion; version < layoutVersion; version += 1) {
    const upgrade = roomLayoutUpgrades[version - 1];
    if (!upgrade) return null;
    layout = upgrade(layout);
  }
  const result = roomLayoutSchema.safeParse(layout);
  return result.success ? result.data : null;
}

const optionalTextSchema = z.string().trim().max(4_000).nullable();

export const propertyCreateSchema = z.object({
  id: clientIdSchema,
  name: z.string().trim().min(1).max(160),
  address: optionalTextSchema.optional(),
  note: optionalTextSchema.optional(),
}).strict();

export const propertyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  address: optionalTextSchema.optional(),
  note: optionalTextSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one property field is required",
});

export const roomCreateSchema = z.object({
  id: clientIdSchema,
  name: z.string().trim().min(1).max(160),
  type: roomTypeSchema,
  layout: roomLayoutSchema,
}).strict();

export const roomUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  type: roomTypeSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one room field is required",
});

export const checklistStatusSchema = z.enum(["pending", "complete", "skipped"]);
export const checklistCategorySchema = z.enum([
  "dimension",
  "door",
  "window",
  "utility",
  "photo",
  "other",
]);

export const checklistCreateSchema = z.object({
  id: clientIdSchema,
  propertyId: clientIdSchema,
  roomId: clientIdSchema.nullable().optional(),
  elementId: clientIdSchema.nullable().optional(),
  label: z.string().trim().min(1).max(300),
  category: checklistCategorySchema.nullable().optional(),
  required: z.boolean().default(false),
  status: checklistStatusSchema.default("pending"),
  measurementId: clientIdSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
}).strict();

export const checklistUpdateSchema = z.object({
  label: z.string().trim().min(1).max(300).optional(),
  category: checklistCategorySchema.nullable().optional(),
  required: z.boolean().optional(),
  status: checklistStatusSchema.optional(),
  measurementId: clientIdSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  elementId: clientIdSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one checklist field is required",
});

export const measurementTypeSchema = z.enum([
  "width",
  "depth",
  "height",
  "distance",
  "area",
  "count",
  "other",
]);
export const measurementUnitSchema = z.enum(["mm", "cm", "m", "sqm", "count"]);

export const measurementCreateSchema = z.object({
  id: clientIdSchema,
  propertyId: clientIdSchema,
  roomId: clientIdSchema.nullable().optional(),
  elementId: clientIdSchema.nullable().optional(),
  checklistItemId: clientIdSchema.nullable().optional(),
  type: measurementTypeSchema,
  value: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  unit: measurementUnitSchema.default("mm"),
  note: optionalTextSchema.optional(),
}).strict();

export const measurementUpdateSchema = z.object({
  elementId: clientIdSchema.nullable().optional(),
  checklistItemId: clientIdSchema.nullable().optional(),
  type: measurementTypeSchema.optional(),
  value: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  unit: measurementUnitSchema.optional(),
  note: optionalTextSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one measurement field is required",
});

export const photoCreateSchema = z.object({
  id: clientIdSchema,
  propertyId: clientIdSchema,
  roomId: clientIdSchema.nullable().optional(),
  elementId: clientIdSchema.nullable().optional(),
  checklistItemId: clientIdSchema.nullable().optional(),
  r2Key: z.string().trim().min(1).max(1_024),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  width: z.number().int().positive().max(20_000).nullable().optional(),
  height: z.number().int().positive().max(20_000).nullable().optional(),
  note: optionalTextSchema.optional(),
}).strict();

export function mutationEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    clientMutationId: clientMutationIdSchema,
    data,
  }).strict();
}

export const emptyMutationSchema = mutationEnvelopeSchema(z.object({}).strict());
export const propertyCreateMutationSchema = mutationEnvelopeSchema(propertyCreateSchema);
export const propertyUpdateMutationSchema = mutationEnvelopeSchema(propertyUpdateSchema);
export const roomCreateMutationSchema = mutationEnvelopeSchema(roomCreateSchema);
export const roomUpdateMutationSchema = mutationEnvelopeSchema(roomUpdateSchema);
export const roomLayoutMutationSchema = mutationEnvelopeSchema(roomLayoutSchema);
export const checklistCreateMutationSchema = mutationEnvelopeSchema(checklistCreateSchema);
export const checklistUpdateMutationSchema = mutationEnvelopeSchema(checklistUpdateSchema);
export const measurementCreateMutationSchema = mutationEnvelopeSchema(measurementCreateSchema);
export const measurementUpdateMutationSchema = mutationEnvelopeSchema(measurementUpdateSchema);
export const photoCreateMutationSchema = mutationEnvelopeSchema(photoCreateSchema);

export type Credentials = z.infer<typeof credentialsSchema>;
export type ClientId = z.infer<typeof clientIdSchema>;
export type ClientMutationId = z.infer<typeof clientMutationIdSchema>;
export type RoomType = z.infer<typeof roomTypeSchema>;
export type Wall = z.infer<typeof wallSchema>;
export type RoomCorner = z.infer<typeof roomCornerSchema>;
export type RoomNotch = z.infer<typeof roomNotchSchema>;
export type DoorElement = z.infer<typeof doorElementSchema>;
export type WindowElement = z.infer<typeof windowElementSchema>;
export type UtilityElement = z.infer<typeof utilityElementSchema>;
export type PropertyCreate = z.infer<typeof propertyCreateSchema>;
export type PropertyUpdate = z.infer<typeof propertyUpdateSchema>;
export type RoomLayout = z.infer<typeof roomLayoutSchema>;
export type RoomCreate = z.infer<typeof roomCreateSchema>;
export type RoomUpdate = z.infer<typeof roomUpdateSchema>;
export type ChecklistCreate = z.infer<typeof checklistCreateSchema>;
export type ChecklistUpdate = z.infer<typeof checklistUpdateSchema>;
export type MeasurementCreate = z.infer<typeof measurementCreateSchema>;
export type MeasurementUpdate = z.infer<typeof measurementUpdateSchema>;
export type PhotoCreate = z.infer<typeof photoCreateSchema>;
