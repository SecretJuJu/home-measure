import type {
  ClientId,
  DoorElement,
  PropertyCreate,
  PropertyUpdate,
  RoomLayout,
  RoomNotch,
  RoomType,
  UtilityElement,
  WindowElement,
} from "@home-measure/domain";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { AccountControl } from "../account";
import { checklistCompletion } from "../checklist/completion";
import { HttpApiClient, HomeMeasureDatabase, LocalFirstRepository } from "../../local";
import type { LocalProperty, LocalRoom } from "../../local";
import { nominalHeights } from "@home-measure/domain";
import {
  clampWallElement,
  cornerPoint,
  doorGeometry,
  floorPlanViewport,
  clampUtilityPosition,
  moveRoom,
  moveWallElement,
  notchInnerCorner,
  panViewport,
  pinchViewport,
  planGridStep,
  pointFromClient,
  positionForGap,
  rectsOverlap,
  resizeRoom,
  resizeRoomCorner,
  roomCorners,
  roomGaps,
  roomLabelBox,
  roomOutlinePath,
  roomRect,
  roomWalls,
  setRoomNotch,
  snapRoomPosition,
  snapTolerance,
  snapUtilityToWall,
  targetWall,
  unitsPerPixel,
  utilityLabel,
  utilityRect,
  utilitySize,
  wallElevation,
  wallElementAtClearance,
  wallElementClearances,
  wallNeighbours,
  wallDirection,
  wallElementPoints,
  wallSegment,
  zoomViewport,
  type NeighborRoom,
  type Point,
  type RoomCorner,
  type RoomGap,
  type SnapGuide,
  type SvgViewport,
  type Wall,
  type WallElevation,
  type WallElevationItem,
} from "./geometry";

type UtilityType = UtilityElement["type"];

export type FloorPlanSelection =
  | { kind: "room"; roomId: ClientId }
  | { kind: "wall"; roomId: ClientId; wall: Wall }
  | { kind: "door"; roomId: ClientId; elementId: ClientId }
  | { kind: "window"; roomId: ClientId; elementId: ClientId }
  | { kind: "utility"; roomId: ClientId; elementId: ClientId }
  | null;

export interface FloorPlanInspectorContext {
  property: LocalProperty;
  room: LocalRoom | undefined;
  selection: FloorPlanSelection;
  select: (selection: FloorPlanSelection) => void;
}

export interface FloorPlanEditorProps {
  /** An owning workspace may inject one repository so checklist and canvas share local state. */
  repository?: LocalFirstRepository;
  selection?: FloorPlanSelection;
  onSelectionChange?: (selection: FloorPlanSelection) => void;
  onRoomCreated?: (room: LocalRoom) => Promise<void>;
  onOpenSummary?: (property: LocalProperty) => void;
  inspectorSupplement?: (context: FloorPlanInspectorContext) => ReactNode;
}

type Placement =
  | { kind: "door" }
  | { kind: "window" }
  | { kind: "utility"; utility: UtilityType }
  | null;

interface DragState {
  roomId: ClientId;
  start: Point;
  layout: RoomLayout;
  current: Point;
}

/** Dragging a bounding corner resizes the room; dragging the reflex corner reshapes the notch. */
type ResizeTarget = { kind: "corner"; corner: RoomCorner } | { kind: "notch" };

interface ResizeState {
  roomId: ClientId;
  target: ResizeTarget;
  current: Point;
}

/** One reversible floor-plan edit. Only layout changes are recorded; deleting a room is not. */
interface LayoutEdit {
  roomId: ClientId;
  previous: RoomLayout;
  next: RoomLayout;
}

/** The frame a two-finger gesture started in: every frame of that gesture is measured against it. */
interface PinchState {
  distance: number;
  viewport: SvgViewport;
  matrix: DOMMatrix | null;
  anchor: Point;
}

interface ObjectDragState {
  roomId: ClientId;
  elementId: ClientId;
  kind: "door" | "window" | "utility";
  current: Point;
}

const roomTypes: ReadonlyArray<{ type: RoomType; label: string }> = [
  { type: "entrance", label: "현관" },
  { type: "living_room", label: "거실" },
  { type: "bedroom", label: "침실" },
  { type: "kitchen", label: "주방" },
  { type: "bathroom", label: "욕실" },
  { type: "balcony", label: "베란다" },
  { type: "other", label: "기타" },
];

const utilityTypes: ReadonlyArray<{ type: UtilityType; label: string; glyph: string }> = [
  { type: "outlet", label: "콘센트", glyph: "⌁" },
  { type: "lan", label: "LAN", glyph: "L" },
  { type: "water", label: "수도", glyph: "W" },
  { type: "drain", label: "배수구", glyph: "D" },
  { type: "gas", label: "가스", glyph: "G" },
  { type: "boiler", label: "보일러", glyph: "B" },
  { type: "ac", label: "에어컨", glyph: "A" },
  { type: "interphone", label: "인터폰", glyph: "I" },
];

function localState(repository: LocalFirstRepository) {
  return useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
}

/** iPad-first local editor. Every mutation reaches IndexedDB before best-effort HTTP sync. */
export function FloorPlanEditor({
  repository: repositoryProp,
  selection: controlledSelection,
  onSelectionChange,
  onRoomCreated,
  inspectorSupplement,
  onOpenSummary,
}: FloorPlanEditorProps = {}) {
  const [ownedRepository] = useState(() => new LocalFirstRepository(new HomeMeasureDatabase(), new HttpApiClient()));
  const repository = repositoryProp ?? ownedRepository;
  const state = localState(repository);
  const [selectedPropertyId, setSelectedPropertyId] = useState<ClientId | null>(null);
  const [uncontrolledSelection, setUncontrolledSelection] = useState<FloorPlanSelection>(null);
  const selection = controlledSelection === undefined ? uncontrolledSelection : controlledSelection;
  const [placement, setPlacement] = useState<Placement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [objectDrag, setObjectDrag] = useState<ObjectDragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  const [past, setPast] = useState<LayoutEdit[]>([]);
  const [future, setFuture] = useState<LayoutEdit[]>([]);
  /** null keeps the canvas fitted to the plan; any pan or zoom freezes the view the user chose. */
  const [view, setView] = useState<SvgViewport | null>(null);
  /** The fitted width at the moment the view froze, so moving a room never changes the reported zoom. */
  const [baseWidth, setBaseWidth] = useState<number | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  /** Canvas width in CSS pixels; label and handle sizes are expressed in pixels and scaled by it. */
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [propertyDraft, setPropertyDraft] = useState({ name: "", address: "" });
  const [roomDraft, setRoomDraft] = useState({ name: "", type: "living_room" as RoomType });
  const [showRoomForm, setShowRoomForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"checklist" | "plan">("checklist");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const inspectorRef = useRef<HTMLElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    if (!inspectorOpen) return;
    const desktop = window.matchMedia?.("(min-width: 1024px)");
    const onResize = () => { if (desktop?.matches) setInspectorOpen(false); };
    desktop?.addEventListener("change", onResize);
    const panel = inspectorRef.current;
    panel?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setInspectorOpen(false); inspectorTriggerRef.current?.focus(); }
      if (event.key !== "Tab" || !panel) return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]')).filter((control) => control.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      desktop?.removeEventListener("change", onResize);
      // Restore after React removes inert; focusing the background before commit is ignored.
      inspectorTriggerRef.current?.focus();
    };
  }, [inspectorOpen]);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SvgViewport>({ x: 0, y: 0, width: 10_000, height: 7_000 });
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchState | null>(null);

  useEffect(() => {
    void repository.rehydrate().catch(() => setError("기기에 저장된 데이터를 열 수 없습니다."));
    return () => { if (!repositoryProp) repository.dispose(); };
  }, [repository, repositoryProp]);

  useEffect(() => {
    if (typeof document === "undefined" || (selection?.kind !== "door" && selection?.kind !== "window")) return;
    if (window.matchMedia?.("(max-width: 1023px)").matches && !inspectorOpen) return;
    document.querySelector<HTMLInputElement>(`[data-inspector-element="${selection.elementId}"]`)?.focus();
  }, [selection, inspectorOpen]);

  function select(nextSelection: FloorPlanSelection) {
    if (controlledSelection === undefined) setUncontrolledSelection(nextSelection);
    onSelectionChange?.(nextSelection);
  }

  const properties = useMemo(
    () => Object.values(state.properties).sort((left, right) => right.updatedAt - left.updatedAt),
    [state.properties],
  );
  const selectedProperty = selectedPropertyId ? state.properties[selectedPropertyId] : properties[0];
  const selectedPropertyIdValue = selectedProperty?.id ?? null;
  const rooms = useMemo(
    () => Object.values(state.rooms)
      .filter((room) => room.propertyId === selectedPropertyIdValue)
      .sort((left, right) => left.createdAt - right.createdAt),
    [state.rooms, selectedPropertyIdValue],
  );
  const fittedViewport = useMemo(() => floorPlanViewport(rooms.map((room) => room.layout)), [rooms]);
  const viewport = view ?? fittedViewport;
  viewportRef.current = viewport;
  const roomById = (id: ClientId) => state.rooms[id];
  const selectedRoom = selection ? roomById(selection.roomId) : undefined;
  const activeRoom = selectedRoom ?? rooms[0];

  useEffect(() => {
    if (!selectedPropertyId && properties[0]) setSelectedPropertyId(properties[0].id);
  }, [properties, selectedPropertyId]);

  // Freezing the fitted view once keeps the canvas still while rooms are dragged or resized.
  useEffect(() => {
    if (view === null && rooms.length > 0) { setView(fittedViewport); setBaseWidth(fittedViewport.width); }
  }, [view, rooms.length, fittedViewport]);

  // Canvas shortcuts stay on the document so they work right after a touch selection, with no focus.
  useEffect(() => {
    if (inspectorOpen) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        stepHistory(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (event.key === "Escape") { setPlacement(null); select(null); return; }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selection || selection.kind === "room" || selection.kind === "wall") return;
        event.preventDefault();
        deleteSelectedElement();
        return;
      }
      const step = event.shiftKey ? 100 : 10;
      const delta = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[event.key];
      if (!delta || !selection) return;
      event.preventDefault();
      nudgeSelection(delta);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspectorOpen, selection, state.rooms, past, future]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => setCanvasWidth(svg.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [state.hydrated, selectedPropertyIdValue]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // React listens to wheel passively at the root, so the canvas needs its own active listener.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewportRef.current;
      if (event.ctrlKey || event.metaKey) {
        const focus = svgPoint(event) ?? viewportCentre(current);
        setView(zoomViewport(current, Math.exp(-event.deltaY / 240), focus));
        return;
      }
      const bounds = svg.getBoundingClientRect();
      const unit = bounds.width > 0 ? current.width / bounds.width : 1;
      setView(panViewport(current, { x: event.deltaX * unit, y: event.deltaY * unit }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [state.hydrated, selectedPropertyIdValue]);

  async function saveProperty(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = propertyDraft.name.trim();
    if (!name) return;
    const property: LocalProperty = {
      id: newId("property"),
      name,
      address: propertyDraft.address.trim() || null,
      note: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dirty: false,
    };
    const data: PropertyCreate = { id: property.id, name: property.name, address: property.address, note: property.note };
    try {
      await repository.persistOptimisticChange({
        entityKind: "property",
        entity: property,
        operation: mutationOperation("POST", "/properties", data),
      });
      setSelectedPropertyId(property.id);
      setPropertyDraft({ name: "", address: "" });
    } catch {
      setError("집을 기기에 저장하지 못했습니다.");
    }
  }

  async function saveRoom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProperty) return;
    const name = roomDraft.name.trim() || roomTypeLabel(roomDraft.type);
    const room: LocalRoom = {
      id: newId("room"),
      propertyId: selectedProperty.id,
      name,
      type: roomDraft.type,
      layout: nextRoomLayout(rooms, activeRoom),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dirty: false,
    };
    try {
      await repository.persistOptimisticChange({
        entityKind: "room",
        entity: room,
        operation: mutationOperation("POST", `/properties/${room.propertyId}/rooms`, {
          id: room.id, name: room.name, type: room.type, layout: room.layout,
        }),
      });
      select({ kind: "room", roomId: room.id });
      // A new room may land outside the framed view, so refit once instead of hiding it.
      setView(null);
      await onRoomCreated?.(room);
      setRoomDraft({ name: "", type: "living_room" });
      setShowRoomForm(false);
    } catch {
      setError("공간을 기기에 저장하지 못했습니다.");
    }
  }

  async function saveRoomLayout(room: LocalRoom, layout: RoomLayout, record = true) {
    if (record) {
      setPast((entries) => [...entries.slice(-49), { roomId: room.id, previous: room.layout, next: layout }]);
      setFuture([]);
    }
    try {
      await repository.persistOptimisticChange({
        entityKind: "room",
        entity: { ...room, layout },
        operation: mutationOperation("PUT", `/rooms/${room.id}/layout`, layout),
      });
    } catch {
      setError("평면도 변경을 기기에 저장하지 못했습니다.");
    }
  }

  /** Replays a recorded edit without recording it again, so undo and redo stay symmetrical. */
  function stepHistory(direction: "undo" | "redo") {
    const entries = direction === "undo" ? past : future;
    const entry = entries.at(-1);
    if (!entry) return;
    if (direction === "undo") { setPast(past.slice(0, -1)); setFuture([...future, entry]); }
    else { setFuture(future.slice(0, -1)); setPast([...past, entry]); }
    const room = roomById(entry.roomId);
    if (room) void saveRoomLayout(room, direction === "undo" ? entry.previous : entry.next, false);
  }

  function deleteSelectedElement() {
    if (!selection || selection.kind === "room" || selection.kind === "wall") return;
    const room = roomById(selection.roomId);
    if (!room) return;
    const layout = selection.kind === "door"
      ? { ...room.layout, doors: room.layout.doors.filter((door) => door.id !== selection.elementId) }
      : selection.kind === "window"
        ? { ...room.layout, windows: room.layout.windows.filter((window) => window.id !== selection.elementId) }
        : { ...room.layout, utilities: room.layout.utilities.filter((utility) => utility.id !== selection.elementId) };
    void saveRoomLayout(room, layout);
    select({ kind: "room", roomId: room.id });
  }

  /** Arrow keys move the selection by a round amount; wall objects slide along their own wall. */
  function nudgeSelection(delta: Point) {
    if (!selection) return;
    const room = roomById(selection.roomId);
    if (!room) return;
    if (selection.kind === "room" || selection.kind === "wall") {
      void saveRoomLayout(room, moveRoom(room.layout, delta));
      return;
    }
    if (selection.kind === "utility") {
      const utilities = room.layout.utilities.map((utility) => utility.id === selection.elementId
        ? { ...utility, position: clampUtilityPosition(room.layout, { x: utility.position.x + delta.x, y: utility.position.y + delta.y }) }
        : utility);
      void saveRoomLayout(room, { ...room.layout, utilities });
      return;
    }
    const along = <T extends DoorElement | WindowElement>(element: T): T => {
      const direction = wallDirection(room.layout, element.wall);
      return clampWallElement(room.layout, { ...element, offset: element.offset + delta.x * direction.x + delta.y * direction.y });
    };
    const layout = selection.kind === "door"
      ? { ...room.layout, doors: room.layout.doors.map((door) => door.id === selection.elementId ? along(door) : door) }
      : { ...room.layout, windows: room.layout.windows.map((window) => window.id === selection.elementId ? along(window) : window) };
    void saveRoomLayout(room, layout);
  }

  /** Slides a door or window along its wall until the requested run of wall is left beside it. */
  function saveElementClearance(room: LocalRoom, element: DoorElement | WindowElement, side: "start" | "end", clearance: number) {
    const moved = wallElementAtClearance(room.layout, element, side, clearance);
    const layout = "hinge" in moved
      ? { ...room.layout, doors: room.layout.doors.map((door) => door.id === moved.id ? moved : door) }
      : { ...room.layout, windows: room.layout.windows.map((window) => window.id === moved.id ? moved : window) };
    void saveRoomLayout(room, layout);
  }

  function saveUtilityPosition(room: LocalRoom, utility: UtilityElement, position: Point) {
    const utilities = room.layout.utilities.map((item) => item.id === utility.id
      ? { ...item, position: clampUtilityPosition(room.layout, position) }
      : item);
    void saveRoomLayout(room, { ...room.layout, utilities });
  }

  function saveUtilitySize(room: LocalRoom, utility: UtilityElement, size: { width: number; height: number }) {
    const utilities = room.layout.utilities.map((item) => item.id === utility.id ? { ...item, size } : item);
    void saveRoomLayout(room, { ...room.layout, utilities });
  }

  /** An empty box clears the measurement rather than storing a guess as if it were one. */
  function saveUtilityFloorHeight(room: LocalRoom, utility: UtilityElement, value: string) {
    const utilities = room.layout.utilities.map((item) => {
      if (item.id !== utility.id) return item;
      const next = { ...item };
      if (value.trim() === "") delete next.floorHeight;
      else next.floorHeight = nonNegativeNumber(value, item.floorHeight ?? nominalHeights.utilityFloor);
      return next;
    });
    void saveRoomLayout(room, { ...room.layout, utilities });
  }

  function saveCeilingHeight(room: LocalRoom, value: string) {
    const layout = { ...room.layout };
    if (value.trim() === "") delete layout.ceilingHeight;
    else layout.ceilingHeight = positiveNumber(value, room.layout.ceilingHeight ?? nominalHeights.ceiling);
    void saveRoomLayout(room, layout);
  }

  function selectElevationItem(room: LocalRoom, item: WallElevationItem) {
    select({ kind: item.kind, roomId: room.id, elementId: item.id as ClientId });
  }

  /** Moves the room along one axis until the requested gap to that neighbour is exact. */
  function saveRoomGap(room: LocalRoom, gap: RoomGap, distance: number) {
    const position = positionForGap(roomRect(room.layout), gap.wall, distance, gap.neighbor.rect);
    if (position.x === room.layout.position.x && position.y === room.layout.position.y) return;
    void saveRoomLayout(room, { ...room.layout, position });
  }

  async function saveRoomName(room: LocalRoom, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === room.name) return;
    try {
      await repository.persistOptimisticChange({
        entityKind: "room",
        entity: { ...room, name: trimmed },
        operation: mutationOperation("PATCH", `/rooms/${room.id}`, { name: trimmed }),
      });
    } catch {
      setError("공간 이름을 기기에 저장하지 못했습니다.");
    }
  }

  async function savePropertyUpdate(property: LocalProperty, update: PropertyUpdate) {
    const next: LocalProperty = {
      ...property,
      ...(update.name === undefined ? {} : { name: update.name }),
      ...(update.address === undefined ? {} : { address: update.address }),
      ...(update.note === undefined ? {} : { note: update.note }),
    };
    if (next.name === property.name && next.address === property.address && next.note === property.note) return;
    try {
      await repository.persistOptimisticChange({
        entityKind: "property",
        entity: next,
        operation: mutationOperation("PATCH", `/properties/${property.id}`, update),
      });
    } catch {
      setError("집 정보를 기기에 저장하지 못했습니다.");
    }
  }

  async function deleteProperty(property: LocalProperty) {
    if (!window.confirm(`“${property.name}”과(와) 포함된 모든 공간을 이 기기에서 삭제할까요?`)) return;
    try {
      await repository.persistOptimisticDeletion({
        entityKind: "property",
        entityId: property.id,
        propertyId: property.id,
        operation: mutationOperation("DELETE", `/properties/${property.id}`, {}),
      });
      const nextProperty = properties.find((item) => item.id !== property.id);
      setSelectedPropertyId(nextProperty?.id ?? null);
      select(null);
    } catch {
      setError("집 삭제를 기기에 저장하지 못했습니다.");
    }
  }

  async function deleteRoom(room: LocalRoom) {
    if (!window.confirm(`“${room.name}” 공간과 연결된 로컬 기록을 삭제할까요?`)) return;
    try {
      await repository.persistOptimisticDeletion({
        entityKind: "room",
        entityId: room.id,
        propertyId: room.propertyId,
        operation: mutationOperation("DELETE", `/rooms/${room.id}`, {}),
      });
      // Deleting a room is not reversible, so its recorded layout edits cannot be replayed either.
      setPast((entries) => entries.filter((entry) => entry.roomId !== room.id));
      setFuture((entries) => entries.filter((entry) => entry.roomId !== room.id));
      select(null);
    } catch {
      setError("공간 삭제를 기기에 저장하지 못했습니다.");
    }
  }

  function svgPoint(event: Pick<ReactPointerEvent<SVGSVGElement>, "clientX" | "clientY">): Point | null {
    const svg = svgRef.current;
    if (!svg) return null;
    // Screen CTM includes SVG letterboxing, so touch coordinates match rendered geometry.
    const matrix = svg.getScreenCTM?.();
    if (matrix) {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      return { x: point.x, y: point.y };
    }
    return pointFromClient({ x: event.clientX, y: event.clientY }, svg.getBoundingClientRect(), viewportRef.current);
  }

  function zoomBy(factor: number) {
    // Derived from the pending view, so repeated taps compound instead of overwriting each other.
    setView((current) => {
      const base = current ?? viewportRef.current;
      return zoomViewport(base, factor, viewportCentre(base));
    });
  }

  /** Maps a client point with the frame captured when the pinch began, never a half-applied one. */
  function pinchPlanPoint(client: Point, pinch: PinchState): Point | null {
    const svg = svgRef.current;
    if (!svg) return null;
    if (pinch.matrix) {
      const point = new DOMPoint(client.x, client.y).matrixTransform(pinch.matrix);
      return { x: point.x, y: point.y };
    }
    return pointFromClient(client, svg.getBoundingClientRect(), pinch.viewport);
  }

  function trackPinch(event: ReactPointerEvent<SVGSVGElement>): boolean {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [first, second] = [...pointers.values()];
    if (!first || !second) return false;
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    const centre = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    let pinch = pinchRef.current;
    if (!pinch) {
      const viewport = viewportRef.current;
      const matrix = svgRef.current?.getScreenCTM?.()?.inverse() ?? null;
      pinch = { distance, viewport, matrix, anchor: { x: 0, y: 0 } };
      pinch.anchor = pinchPlanPoint(centre, pinch) ?? viewportCentre(viewport);
      pinchRef.current = pinch;
      return true;
    }
    if (pinch.distance === 0 || distance === 0) return true;
    // Two fingers pan and zoom at once: the grabbed plan point follows the moving midpoint.
    const centrePlan = pinchPlanPoint(centre, pinch);
    if (!centrePlan) return true;
    setView(pinchViewport(pinch.viewport, distance / pinch.distance, pinch.anchor, {
      x: (centrePlan.x - pinch.viewport.x) / pinch.viewport.width,
      y: (centrePlan.y - pinch.viewport.y) / pinch.viewport.height,
    }));
    return true;
  }

  function releasePointer(pointerId: number) {
    pointersRef.current.delete(pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  }

  function handleRoomPointerDown(event: ReactPointerEvent<SVGGElement>, room: LocalRoom) {
    const point = svgPoint(event);
    if (!point) return;
    if (placement) {
      void placeObject(room, point);
      return;
    }
    const wall = targetWall(room.layout, point);
    if (wall) {
      select({ kind: "wall", roomId: room.id, wall: wall.wall });
      return;
    }
    if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
    select({ kind: "room", roomId: room.id });
    setDrag({ roomId: room.id, start: point, current: point, layout: room.layout });
  }

  function handleSvgPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size < 2) {
      // Nothing under the finger means empty canvas: drop the selection like any design tool.
      const target = event.target as Element;
      if (target === svgRef.current || target.classList.contains("canvas-grid")) select(null);
      return;
    }
    // A second finger means the user is framing the plan, not moving an object.
    setDrag(null);
    setObjectDrag(null);
    setResize(null);
    pinchRef.current = null;
    trackPinch(event);
  }

  function handleResizePointerDown(event: ReactPointerEvent<SVGRectElement | SVGCircleElement>, room: LocalRoom, target: ResizeTarget) {
    const point = svgPoint(event);
    if (!point) return;
    event.stopPropagation();
    if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
    select({ kind: "room", roomId: room.id });
    setResize({ roomId: room.id, target, current: point });
  }

  function handleSvgPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (pointersRef.current.size >= 2) {
      trackPinch(event);
      return;
    }
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (resize) {
      const point = svgPoint(event);
      if (point) setResize({ ...resize, current: point });
      return;
    }
    if (objectDrag) {
      const point = svgPoint(event);
      if (point) setObjectDrag({ ...objectDrag, current: point });
      return;
    }
    if (!drag) return;
    const point = svgPoint(event);
    if (point) setDrag({ ...drag, current: point });
  }

  function handleSvgPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    releasePointer(event.pointerId);
    if (resize) {
      const point = svgPoint(event) ?? resize.current;
      const room = roomById(resize.roomId);
      setResize(null);
      if (!room) return;
      const { layout } = resizedRoom(room, { ...resize, current: point });
      if (reshaped(room.layout, layout)) void saveRoomLayout(room, layout);
      return;
    }
    if (objectDrag) {
      const point = svgPoint(event) ?? objectDrag.current;
      const room = roomById(objectDrag.roomId);
      setObjectDrag(null);
      if (!room) return;
      const layout = layoutWithDraggedObject(room.layout, objectDrag, point, snapEnabled ? snapTolerance(viewportRef.current) : 0);
      void saveRoomLayout(room, layout);
      return;
    }
    if (!drag) return;
    const point = svgPoint(event) ?? drag.current;
    const room = roomById(drag.roomId);
    setDrag(null);
    if (!room) return;
    const { layout } = draggedRoom({ ...drag, current: point });
    if (layout.position.x !== room.layout.position.x || layout.position.y !== room.layout.position.y) void saveRoomLayout(room, layout);
  }

  /** Applies the live drag offset and, unless snapping is off, the pull towards neighbouring rooms. */
  function draggedRoom(state: DragState): { layout: RoomLayout; guides: SnapGuide[] } {
    const moved = moveRoom(state.layout, { x: state.current.x - state.start.x, y: state.current.y - state.start.y });
    if (!snapEnabled) return { layout: moved, guides: [] };
    const snapped = snapRoomPosition(moved, otherRoomLayouts(state.roomId), snapTolerance(viewportRef.current));
    return { layout: { ...moved, position: snapped.position }, guides: snapped.guides };
  }

  /** Grows or shrinks the room from the dragged corner, keeping every element inside the new walls. */
  function resizedRoom(room: LocalRoom, state: ResizeState): { layout: RoomLayout; guides: SnapGuide[] } {
    if (state.target.kind === "notch") return { layout: reshapedNotch(room, state.current), guides: [] };
    const { rect, guides } = resizeRoomCorner(
      roomRect(room.layout),
      state.target.corner,
      state.current,
      snapEnabled ? otherRoomLayouts(room.id) : [],
      snapTolerance(viewportRef.current),
    );
    const moved = { ...room.layout, position: { x: rect.x, y: rect.y } };
    return { layout: resizeRoom(moved, { width: rect.width, height: rect.height }), guides };
  }

  /** The reflex corner follows the finger, so the notch is as deep and wide as the pointer says. */
  function reshapedNotch(room: LocalRoom, point: Point): RoomLayout {
    const notch = room.layout.notch;
    if (!notch) return room.layout;
    const rect = roomRect(room.layout);
    const west = notch.corner === "northWest" || notch.corner === "southWest";
    const north = notch.corner === "northWest" || notch.corner === "northEast";
    return setRoomNotch(room.layout, {
      corner: notch.corner,
      width: Math.round(west ? point.x - rect.x : rect.x + rect.width - point.x),
      height: Math.round(north ? point.y - rect.y : rect.y + rect.height - point.y),
    });
  }

  function otherRoomLayouts(excludedId: ClientId) {
    return rooms.filter((room) => room.id !== excludedId).map((room) => room.layout);
  }

  function handleObjectPointerDown(
    event: ReactPointerEvent<SVGGElement | SVGLineElement>,
    room: LocalRoom,
    kind: ObjectDragState["kind"],
    elementId: ClientId,
  ) {
    const point = svgPoint(event);
    if (!point) return;
    event.stopPropagation();
    if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
    select({ kind, roomId: room.id, elementId });
    setObjectDrag({ roomId: room.id, kind, elementId, current: point });
  }

  async function placeObject(room: LocalRoom, point: Point) {
    if (!placement) return;
    if (placement.kind === "utility") {
      const rect = roomRect(room.layout);
      if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) {
        setError("설비는 선택한 공간 안에 배치하세요.");
        return;
      }
      const placed: UtilityElement = { id: newId("utility"), type: placement.utility, position: { x: Math.round(point.x), y: Math.round(point.y) } };
      const utility: UtilityElement = { ...placed, position: snapUtilityToWall(room.layout, placed, snapEnabled ? snapTolerance(viewportRef.current) : 0) };
      await saveRoomLayout(room, { ...room.layout, utilities: [...room.layout.utilities, utility] });
      select({ kind: "utility", roomId: room.id, elementId: utility.id });
      setPlacement(null);
      return;
    }
    const wall = targetWall(room.layout, point);
    if (!wall) {
      setError("문과 창문은 선택한 공간의 벽을 눌러 배치하세요.");
      return;
    }
    const width = placement.kind === "door" ? 820 : 1200;
    if (placement.kind === "door") {
      const element = clampWallElement(room.layout, {
        id: newId("door"), wall: wall.wall, offset: Math.round(wall.offset - width / 2), width,
        hinge: "left" as const, opening: "inward" as const,
      });
      await saveRoomLayout(room, { ...room.layout, doors: [...room.layout.doors, element] });
      select({ kind: "door", roomId: room.id, elementId: element.id });
    } else {
      const element = clampWallElement(room.layout, {
        id: newId("window"), wall: wall.wall, offset: Math.round(wall.offset - width / 2), width,
        height: 1200, sillHeight: 900, opening: "sliding" as const,
      });
      await saveRoomLayout(room, { ...room.layout, windows: [...room.layout.windows, element] });
      select({ kind: "window", roomId: room.id, elementId: element.id });
    }
    setPlacement(null);
  }

  function updateDoor(room: LocalRoom, elementId: ClientId, patch: Partial<DoorElement>) {
    const doors = room.layout.doors.map((door) => {
      if (door.id !== elementId) return door;
      return clampWallElement(room.layout, { ...door, ...patch });
    });
    void saveRoomLayout(room, { ...room.layout, doors });
  }

  function updateWindow(room: LocalRoom, elementId: ClientId, patch: Partial<WindowElement>) {
    const windows = room.layout.windows.map((window) => {
      if (window.id !== elementId) return window;
      return clampWallElement(room.layout, { ...window, ...patch });
    });
    void saveRoomLayout(room, { ...room.layout, windows });
  }

  const dragRoom = drag ? roomById(drag.roomId) : undefined;
  const resizeRoomTarget = resize ? roomById(resize.roomId) : undefined;
  const dragResult = drag && dragRoom ? draggedRoom(drag) : resize && resizeRoomTarget ? resizedRoom(resizeRoomTarget, resize) : null;
  const gestureRoomId = drag?.roomId ?? resize?.roomId ?? null;
  const measuredRoom = dragRoom ?? resizeRoomTarget ?? (selection?.kind === "room" || selection?.kind === "wall" ? selectedRoom : undefined);
  const measuredLayout = dragResult?.layout ?? measuredRoom?.layout;
  const gaps = measuredRoom && measuredLayout
    ? roomGaps(roomRect(measuredLayout), neighborRooms(rooms, measuredRoom.id))
    : [];
  // While dragging, "맞닿음" confirms the snap. Standing still, a shared wall speaks for itself and
  // repeating it on every touching room would bury the distances that actually carry information.
  const visibleGaps = gestureRoomId
    ? gaps
    : selection?.kind === "wall"
      ? gaps.filter((gap) => gap.wall === selection.wall)
      : gaps.filter((gap) => gap.distance > 0);
  const zoomPercentage = Math.round(((baseWidth ?? fittedViewport.width) / viewport.width) * 100);
  const gridStep = planGridStep(viewport);
  const pixel = unitsPerPixel(viewport, canvasWidth);

  if (!state.hydrated) return <main className="floor-plan-loading">기기 데이터를 불러오는 중…</main>;

  if (!selectedProperty) {
    return (
      <main className="property-onboarding">
        <section aria-labelledby="property-create-title">
          <p className="eyebrow">HomeMeasure</p>
          <h1 id="property-create-title">새 집을 시작하세요</h1>
          <p>현장에서도 바로 저장되는 기본 평면도를 만듭니다.</p>
          <form onSubmit={saveProperty} className="stack-form">
            <label>집 이름<input autoFocus value={propertyDraft.name} onChange={(event) => setPropertyDraft({ ...propertyDraft, name: event.target.value })} placeholder="예: 성수동 새집" /></label>
            <label>주소 (선택)<input value={propertyDraft.address} onChange={(event) => setPropertyDraft({ ...propertyDraft, address: event.target.value })} placeholder="예: 서울 성동구" /></label>
            <button className="primary-action" type="submit" aria-label="새 집 만들기">집 만들기</button>
          </form>
          {error && <p className="form-error" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className={`floor-plan-shell mobile-${mobileView} ${inspectorOpen ? "inspector-open" : ""}`}>
      <header className="workspace-header" inert={inspectorOpen}>
        <div className="workspace-brand"><span className="brand-mark" aria-hidden="true">⌑</span><strong>HomeMeasure</strong><span className="workspace-context">현장 실측</span></div>
        <div className={`sync-indicator ${!online ? "offline" : state.syncStatus}`} role="status">
          <span aria-hidden="true">{!online || state.syncStatus === "offline" ? "○" : state.syncStatus === "syncing" ? "↑" : state.syncStatus === "error" ? "!" : state.syncStatus === "signed-out" ? "○" : "✓"}</span>
          {!online ? "오프라인" : state.syncStatus === "syncing" ? "동기화 중" : state.syncStatus === "offline" ? "연결 대기" : state.syncStatus === "signed-out" ? "기기에 저장됨" : state.syncStatus === "error" ? "동기화 실패" : state.pendingOperationCount > 0 ? "동기화 대기" : Object.values(state.properties).some((item) => item.dirty) || Object.values(state.rooms).some((item) => item.dirty) || Object.values(state.checklistItems).some((item) => item.dirty) || Object.values(state.measurements).some((item) => item.dirty) ? "저장 중" : "동기화됨"}
          {state.pendingOperationCount > 0 && <small>{state.syncStatus === "signed-out" ? `${state.pendingOperationCount}건 로그인 후 전송` : `${state.pendingOperationCount}건 대기`}</small>}
          {online && state.syncStatus === "error" && <button type="button" className="sync-retry" onClick={() => void repository.flush()} title={state.lastSyncError ?? undefined} aria-label="동기화 다시 시도">다시 시도</button>}
        </div>
        {/* Signing in is what lets the queue reach the server, so flush as soon as it happens. */}
        <AccountControl onAccountChange={(account) => { if (account) void repository.flush(); }} />
      </header>
      <aside className="room-pane" aria-label="공간 목록" inert={inspectorOpen}>
        <div className="pane-heading">
          <div><p className="eyebrow">실측 프로젝트</p><h1>{selectedProperty.name}</h1></div>
          <select aria-label="속성 선택" value={selectedProperty.id} onChange={(event) => { setSelectedPropertyId(event.target.value as ClientId); select(null); setView(null); }}>
            {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </select>
        </div>
        <details className="property-details"><summary>집 정보 편집</summary><PropertyEditor property={selectedProperty} onSave={savePropertyUpdate} onDelete={deleteProperty} /></details>
        <div className="room-list-heading"><span>공간</span><span>{rooms.length}</span></div>
        <select className="mobile-room-select" aria-label="현재 공간" value={activeRoom?.id ?? ""} onChange={(event) => select({ kind: "room", roomId: event.target.value as ClientId })}><option value="" disabled>공간을 선택하세요</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select>
        <nav className="room-list" aria-label="공간 선택">
          {rooms.map((room) => {
            const progress = checklistCompletion(Object.values(state.checklistItems).filter((item) => item.roomId === room.id));
            return <button key={room.id} className={activeRoom?.id === room.id ? "room-list-item selected" : "room-list-item"} onClick={() => select({ kind: "room", roomId: room.id })} aria-label={`${room.name} 선택`}>
              <span className={`room-status ${progress.percentage === 100 ? "complete" : ""}`} aria-hidden="true">{progress.percentage === 100 ? "✓" : "○"}</span><span>{room.name}</span><small>{roomTypeLabel(room.type)} · {progress.complete}/{progress.total} 완료</small>
              {progress.requiredMissing.length > 0 && <small className="room-missing">필수 {progress.requiredMissing.length} 미측정</small>}
            </button>;
          })}
        </nav>
        <button className="secondary-action" type="button" onClick={() => { setShowRoomForm(true); setPlacement(null); }} aria-label="공간 추가">+ 공간</button>
        {showRoomForm && (
          <form className="room-create-form" onSubmit={saveRoom}>
            <label>공간 이름<input autoFocus value={roomDraft.name} onChange={(event) => setRoomDraft({ ...roomDraft, name: event.target.value })} placeholder="예: 거실" /></label>
            <label>공간 유형<select value={roomDraft.type} onChange={(event) => setRoomDraft({ ...roomDraft, type: event.target.value as RoomType })}>{roomTypes.map(({ type, label }) => <option key={type} value={type}>{label}</option>)}</select></label>
            <div className="form-actions"><button type="button" onClick={() => setShowRoomForm(false)}>취소</button><button className="primary-action" type="submit">생성</button></div>
          </form>
        )}
      </aside>

      <section className="plan-pane" aria-label="SVG 평면도 편집기" inert={inspectorOpen}>
        <div className="plan-caption">
          <div><span className="eyebrow">{activeRoom?.name ?? "평면도"} · mm</span><p>{placement ? placementInstruction(placement) : "공간 이동 · 벽과 객체 선택 · 두 손가락으로 확대"}</p></div>
          <div className="plan-history" role="group" aria-label="평면도 편집 되돌리기">
            <button type="button" aria-label="실행 취소" disabled={past.length === 0} onClick={() => stepHistory("undo")}>↺</button>
            <button type="button" aria-label="다시 실행" disabled={future.length === 0} onClick={() => stepHistory("redo")}>↻</button>
          </div>
          <button ref={inspectorTriggerRef} className="inspector-trigger" type="button" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(true)}>속성 · 체크리스트</button>
          {placement && <button type="button" onClick={() => setPlacement(null)} aria-label="배치 취소">취소</button>}
        </div>
        <svg
          ref={svgRef}
          className="floor-plan-canvas"
          viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
          role="application"
          aria-label="평면도. 공간을 이동하거나 벽과 객체를 선택할 수 있습니다. 두 손가락으로 확대·축소합니다."
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
          onPointerCancel={handleSvgPointerUp}
        >
          <defs><pattern id="grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse"><path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth={pixel} /></pattern></defs>
          <rect x={viewport.x} y={viewport.y} width={viewport.width} height={viewport.height} className="canvas-grid" />
          {rooms.map((room) => {
            const displayLayout = dragResult && gestureRoomId === room.id ? dragResult.layout : room.layout;
            const objectDragLayout = objectDrag?.roomId === room.id ? layoutWithDraggedObject(displayLayout, objectDrag, objectDrag.current, snapEnabled ? snapTolerance(viewport) : 0) : displayLayout;
            return <RoomDrawing key={room.id} room={room} layout={objectDragLayout} pixel={pixel} selection={selection} placementActive={placement !== null} resizable={selection?.roomId === room.id && placement === null && !drag && !objectDrag} onPointerDown={handleRoomPointerDown} onObjectPointerDown={handleObjectPointerDown} onResizePointerDown={handleResizePointerDown} onSelect={select} />;
          })}
          {visibleGaps.map((gap) => <GapDimension key={`${measuredRoom?.id}-${gap.wall}`} gap={gap} pixel={pixel} />)}
          {dragResult?.guides.map((guide) => <line
            key={`${guide.axis}-${guide.position}`}
            className="snap-guide"
            x1={guide.axis === "x" ? guide.position : guide.from}
            y1={guide.axis === "x" ? guide.from : guide.position}
            x2={guide.axis === "x" ? guide.position : guide.to}
            y2={guide.axis === "x" ? guide.to : guide.position}
          />)}
          {rooms.length === 0 && <text x={viewport.x + viewport.width / 2} y={viewport.y + viewport.height / 2} className="empty-plan-label" style={{ fontSize: pixel * 16 }} textAnchor="middle">아래 또는 왼쪽에서 공간을 추가하세요</text>}
        </svg>
        <div className="canvas-controls" role="group" aria-label="평면도 보기 조절">
          <button type="button" aria-label="축소" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <button type="button" className="zoom-level" aria-label="화면에 맞추기" onClick={() => setView(null)}>{zoomPercentage}%</button>
          <button type="button" aria-label="확대" onClick={() => zoomBy(1.25)}>+</button>
          <button type="button" className="snap-toggle" aria-pressed={snapEnabled} aria-label="자석 정렬" onClick={() => setSnapEnabled(!snapEnabled)}>자석</button>
        </div>
        {error && <p className="canvas-error" role="alert">{error}</p>}
      </section>

      {inspectorOpen && <button className="inspector-backdrop" aria-label="Inspector 닫기" tabIndex={-1} onClick={() => { setInspectorOpen(false); inspectorTriggerRef.current?.focus(); }} />}
      <aside ref={inspectorRef} className="inspector-pane" aria-label="선택한 객체 편집" role={inspectorOpen ? "dialog" : undefined} aria-modal={inspectorOpen || undefined}>
        <div className="inspector-mobile-heading"><strong>속성 · 체크리스트</strong><button type="button" onClick={() => { setInspectorOpen(false); inspectorTriggerRef.current?.focus(); }}>닫기</button></div>
        <div className="object-inspector">
        <Inspector selection={selection} room={selectedRoom} gaps={gaps} onRoomName={saveRoomName} onRoomResize={(room, size) => void saveRoomLayout(room, resizeRoom(room.layout, size))} onRoomGap={saveRoomGap} onRoomNotch={(room, notch) => void saveRoomLayout(room, setRoomNotch(room.layout, notch))} onElementMove={saveElementClearance} onUtilityMove={saveUtilityPosition} onUtilityResize={saveUtilitySize} onUtilityFloorHeight={saveUtilityFloorHeight} onCeilingHeight={saveCeilingHeight} onSelectElement={selectElevationItem} onRoomDelete={deleteRoom} onElementDelete={deleteSelectedElement} onDoorChange={updateDoor} onWindowChange={updateWindow} />
        </div>
        {inspectorSupplement?.({ property: selectedProperty, room: activeRoom, selection, select })}
      </aside>

      <footer className="quick-add-toolbar" aria-label="빠른 추가 도구" inert={inspectorOpen}>
        <span className="quick-add-context">{activeRoom?.name ?? "평면도"}<small>빠른 추가</small></span>
        <button type="button" onClick={() => { setShowRoomForm(true); setPlacement(null); }} aria-label="공간 추가">+ 공간</button>
        <button type="button" disabled={!activeRoom} aria-pressed={placement?.kind === "door"} onClick={() => setPlacement({ kind: "door" })} aria-label="문 배치">+ 문</button>
        <button type="button" disabled={!activeRoom} aria-pressed={placement?.kind === "window"} onClick={() => setPlacement({ kind: "window" })} aria-label="창문 배치">+ 창문</button>
        {utilityTypes.slice(0, 1).map((utility) => <button key={utility.type} type="button" disabled={!activeRoom} aria-pressed={placement?.kind === "utility" && placement.utility === utility.type} onClick={() => setPlacement({ kind: "utility", utility: utility.type })} aria-label={`${utility.label} 배치`}>{utility.glyph} {utility.label}</button>)}
        <div className="utility-tools"><button type="button" aria-expanded={utilitiesOpen} onClick={() => setUtilitiesOpen(!utilitiesOpen)}>설비 더 보기 {utilitiesOpen ? "−" : "+"}</button>{utilitiesOpen && <div className="utility-popover">{utilityTypes.slice(1).map((utility) => <button key={utility.type} type="button" disabled={!activeRoom} aria-label={`${utility.label} 배치`} onClick={() => { setPlacement({ kind: "utility", utility: utility.type }); setUtilitiesOpen(false); }}>{utility.glyph} {utility.label}</button>)}</div>}</div>
      </footer>
      <nav className="mobile-navigation" aria-label="현장 화면" inert={inspectorOpen}>
        <button type="button" aria-pressed={mobileView === "checklist"} onClick={() => { setMobileView("checklist"); setInspectorOpen(false); }}>체크리스트</button>
        <button type="button" aria-pressed={mobileView === "plan"} onClick={() => setMobileView("plan")}>평면도</button>
        {onOpenSummary && <button type="button" onClick={() => onOpenSummary(selectedProperty)}>요약</button>}
      </nav>
    </main>
  );
}

function RoomDrawing({ room, layout, pixel, selection, placementActive, resizable, onPointerDown, onObjectPointerDown, onResizePointerDown, onSelect }: {
  room: LocalRoom;
  layout: RoomLayout;
  pixel: number;
  selection: FloorPlanSelection;
  placementActive: boolean;
  resizable: boolean;
  onPointerDown: (event: ReactPointerEvent<SVGGElement>, room: LocalRoom) => void;
  onObjectPointerDown: (event: ReactPointerEvent<SVGGElement | SVGLineElement>, room: LocalRoom, kind: ObjectDragState["kind"], elementId: ClientId) => void;
  onResizePointerDown: (event: ReactPointerEvent<SVGRectElement | SVGCircleElement>, room: LocalRoom, target: ResizeTarget) => void;
  onSelect: (selection: FloorPlanSelection) => void;
}) {
  const rect = roomRect(layout);
  const roomSelected = selection?.roomId === room.id;
  const dimension = `${layout.size.width.toLocaleString()} × ${layout.size.height.toLocaleString()} mm`;
  const label = roomLabelBox(layout);
  const notchCorner = notchInnerCorner(layout);
  const nameSize = pixel * 15;
  const dimensionSize = pixel * 12;
  return (
    <g className={roomSelected ? "room-drawing selected" : "room-drawing"} onPointerDown={(event) => onPointerDown(event, room)}>
      <path d={roomOutlinePath(layout)} className="room-fill" />
      {roomWalls(layout).map((wall) => {
        const segment = wallSegment(layout, wall);
        return <g key={wall}><line x1={segment.start.x} y1={segment.start.y} x2={segment.end.x} y2={segment.end.y} className={selection?.kind === "wall" && selection.roomId === room.id && selection.wall === wall ? "wall-line active" : "wall-line"} /><line x1={segment.start.x} y1={segment.start.y} x2={segment.end.x} y2={segment.end.y} className="object-hit-line" role="button" tabIndex={0} aria-label={`${room.name} ${wallLabel(wall)} 선택`} onPointerDown={(event) => { if (!placementActive) { event.stopPropagation(); onSelect({ kind: "wall", roomId: room.id, wall }); } }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect({ kind: "wall", roomId: room.id, wall }); } }} /></g>;
      })}
      {/* A label that spills into the room next door is worse than none; zooming in brings it back. */}
      {fitsInside(room.name, nameSize, label.width) && <text x={label.x + label.width / 2} y={label.y + label.height / 2} className="room-label" style={{ fontSize: nameSize }} textAnchor="middle">{room.name}</text>}
      {fitsInside(dimension, dimensionSize, label.width) && label.height >= nameSize * 2.6 && <text x={label.x + label.width / 2} y={label.y + label.height / 2 + pixel * 18} className="room-dimension" style={{ fontSize: dimensionSize }} textAnchor="middle">{dimension}</text>}
      {layout.doors.map((door) => <DoorDrawing key={door.id} layout={layout} door={door} selected={selection?.kind === "door" && selection.elementId === door.id} onPointerDown={(event) => onObjectPointerDown(event, room, "door", door.id)} onSelect={() => onSelect({ kind: "door", roomId: room.id, elementId: door.id })} />)}
      {layout.windows.map((window) => <WindowDrawing key={window.id} layout={layout} window={window} selected={selection?.kind === "window" && selection.elementId === window.id} onPointerDown={(event) => onObjectPointerDown(event, room, "window", window.id)} onSelect={() => onSelect({ kind: "window", roomId: room.id, elementId: window.id })} />)}
      {layout.utilities.map((utility) => <UtilityDrawing key={utility.id} utility={utility} pixel={pixel} selected={selection?.kind === "utility" && selection.elementId === utility.id} onPointerDown={(event) => onObjectPointerDown(event, room, "utility", utility.id)} onSelect={() => onSelect({ kind: "utility", roomId: room.id, elementId: utility.id })} />)}
      {resizable && roomCorners.map((corner) => {
        const point = cornerPoint(rect, corner);
        const size = pixel * 7;
        const touch = pixel * 40;
        return <g key={corner} className="resize-handle">
          <rect x={point.x - size / 2} y={point.y - size / 2} width={size} height={size} rx={size / 5} />
          <rect
            x={point.x - touch / 2} y={point.y - touch / 2} width={touch} height={touch}
            className="resize-hit"
            role="button"
            tabIndex={0}
            aria-label={`${room.name} ${cornerLabel(corner)} 크기 조절`}
            onPointerDown={(event) => onResizePointerDown(event, room, { kind: "corner", corner })}
          />
        </g>;
      })}
      {resizable && notchCorner && <g className="resize-handle notch-handle">
        <circle cx={notchCorner.x} cy={notchCorner.y} r={pixel * 5} />
        <circle
          cx={notchCorner.x} cy={notchCorner.y} r={pixel * 20}
          className="resize-hit"
          role="button"
          tabIndex={0}
          aria-label={`${room.name} 파낸 모서리 조절`}
          onPointerDown={(event) => onResizePointerDown(event, room, { kind: "notch" })}
        />
      </g>}
    </g>
  );
}

function DoorDrawing({ layout, door, selected, onPointerDown, onSelect }: { layout: RoomLayout; door: DoorElement; selected: boolean; onPointerDown: (event: ReactPointerEvent<SVGGElement>) => void; onSelect: () => void }) {
  const geometry = doorGeometry(layout, door);
  return <g className={selected ? "door-drawing selected" : "door-drawing"} role="button" tabIndex={0} aria-label={`문 선택, 폭 ${door.width}mm`} onPointerDown={onPointerDown} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
    <line x1={geometry.hinge.x} y1={geometry.hinge.y} x2={geometry.closedEnd.x} y2={geometry.closedEnd.y} className="door-line" />
    <line x1={geometry.hinge.x} y1={geometry.hinge.y} x2={geometry.closedEnd.x} y2={geometry.closedEnd.y} className="object-hit-line" />
    <path d={geometry.arcPath} className="door-arc" />
    <circle cx={geometry.hinge.x} cy={geometry.hinge.y} r="54" className="hinge-dot" />
  </g>;
}

function WindowDrawing({ layout, window, selected, onPointerDown, onSelect }: { layout: RoomLayout; window: WindowElement; selected: boolean; onPointerDown: (event: ReactPointerEvent<SVGGElement>) => void; onSelect: () => void }) {
  const points = wallElementPoints(layout, window);
  return <g role="button" tabIndex={0} aria-label={`창문 선택, 폭 ${window.width}mm`} onPointerDown={onPointerDown} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}><line x1={points.start.x} y1={points.start.y} x2={points.end.x} y2={points.end.y} className={selected ? "window-line selected" : "window-line"} /><line x1={points.start.x} y1={points.start.y} x2={points.end.x} y2={points.end.y} className="object-hit-line" /></g>;
}

function UtilityDrawing({ utility, pixel, selected, onPointerDown, onSelect }: { utility: UtilityElement; pixel: number; selected: boolean; onPointerDown: (event: ReactPointerEvent<SVGGElement>) => void; onSelect: () => void }) {
  const glyph = utilityTypes.find((item) => item.type === utility.type)?.glyph ?? "•";
  const rect = utilityRect(utility);
  const touch = pixel * 40;
  return <g className={selected ? "utility-marker selected" : "utility-marker"} role="button" tabIndex={0} aria-label={`${utilityLabel(utility)} 선택`} onPointerDown={onPointerDown} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}>
    <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} />
    <text x={utility.position.x} y={utility.position.y + pixel * 4} style={{ fontSize: pixel * 11 }} textAnchor="middle">{glyph}</text>
    <rect x={utility.position.x - touch / 2} y={utility.position.y - touch / 2} width={touch} height={touch} className="object-hit-rect" />
  </g>;
}

/** Draws the free distance between one wall and the room facing it, with a label the user can read at any zoom. */
function GapDimension({ gap, pixel }: { gap: RoomGap; pixel: number }) {
  const vertical = gap.wall === "north" || gap.wall === "south";
  const tick = pixel * 5;
  const label = pixel * 11;
  const centre = { x: (gap.start.x + gap.end.x) / 2, y: (gap.start.y + gap.end.y) / 2 };
  return <g className="gap-dimension" aria-hidden="true">
    <line x1={gap.start.x} y1={gap.start.y} x2={gap.end.x} y2={gap.end.y} className="gap-line" />
    {[gap.start, gap.end].map((point, index) => <line
      key={index}
      className="gap-tick"
      x1={vertical ? point.x - tick : point.x}
      y1={vertical ? point.y : point.y - tick}
      x2={vertical ? point.x + tick : point.x}
      y2={vertical ? point.y : point.y + tick}
    />)}
    <text
      x={vertical ? centre.x + tick : centre.x}
      y={vertical ? centre.y : centre.y - tick}
      className="gap-label"
      style={{ fontSize: label }}
      textAnchor={vertical ? "start" : "middle"}
    >{gap.distance === 0 ? "맞닿음" : `${gap.distance.toLocaleString()} mm`}</text>
  </g>;
}

function Inspector({ selection, room, gaps, onRoomName, onRoomResize, onRoomGap, onRoomNotch, onElementMove, onUtilityMove, onUtilityResize, onUtilityFloorHeight, onCeilingHeight, onSelectElement, onRoomDelete, onElementDelete, onDoorChange, onWindowChange }: {
  selection: FloorPlanSelection;
  room: LocalRoom | undefined;
  gaps: RoomGap[];
  onRoomName: (room: LocalRoom, name: string) => Promise<void>;
  onRoomResize: (room: LocalRoom, size: RoomLayout["size"]) => void;
  onRoomGap: (room: LocalRoom, gap: RoomGap, distance: number) => void;
  onRoomNotch: (room: LocalRoom, notch: RoomNotch | null) => void;
  onElementMove: (room: LocalRoom, element: DoorElement | WindowElement, side: "start" | "end", clearance: number) => void;
  onUtilityMove: (room: LocalRoom, utility: UtilityElement, position: Point) => void;
  onUtilityResize: (room: LocalRoom, utility: UtilityElement, size: { width: number; height: number }) => void;
  onUtilityFloorHeight: (room: LocalRoom, utility: UtilityElement, value: string) => void;
  onCeilingHeight: (room: LocalRoom, value: string) => void;
  onSelectElement: (room: LocalRoom, item: WallElevationItem) => void;
  onRoomDelete: (room: LocalRoom) => Promise<void>;
  onElementDelete: () => void;
  onDoorChange: (room: LocalRoom, elementId: ClientId, patch: Partial<DoorElement>) => void;
  onWindowChange: (room: LocalRoom, elementId: ClientId, patch: Partial<WindowElement>) => void;
}) {
  if (!selection || !room) return <div className="empty-inspector"><h2>Inspector</h2><p>공간, 벽, 문, 창문 또는 설비를 선택하세요.</p></div>;
  if (selection.kind === "room") return <div className="inspector-content"><p className="eyebrow">공간</p><h2>{room.name}</h2><label>공간 이름<input defaultValue={room.name} key={room.name} onBlur={(event) => void onRoomName(room, event.target.value)} aria-label="공간 이름" /></label><label>공간 가로 (mm)<input type="number" min="1" defaultValue={room.layout.size.width} key={`width-${room.layout.size.width}`} onBlur={(event) => onRoomResize(room, { width: positiveNumber(event.target.value, room.layout.size.width), height: room.layout.size.height })} aria-label="공간 가로 밀리미터" /></label><label>공간 세로 (mm)<input type="number" min="1" defaultValue={room.layout.size.height} key={`height-${room.layout.size.height}`} onBlur={(event) => onRoomResize(room, { width: room.layout.size.width, height: positiveNumber(event.target.value, room.layout.size.height) })} aria-label="공간 세로 밀리미터" /></label><label>천장 높이 (mm)<input type="number" min="1" placeholder={String(nominalHeights.ceiling)} defaultValue={room.layout.ceilingHeight ?? ""} key={`ceiling-${room.layout.ceilingHeight ?? "none"}`} onBlur={(event) => onCeilingHeight(room, event.target.value)} aria-label="천장 높이 밀리미터" /></label><p className="inspector-help">모서리 손잡이를 끌어 크기를 바꿀 수 있고, 치수를 줄이면 문·창문과 설비 위치를 새 경계 안으로 자동 보정합니다.</p><NotchEditor room={room} onRoomNotch={onRoomNotch} /><GapEditor room={room} gaps={gaps} onRoomGap={onRoomGap} /><button type="button" className="danger-action" onClick={() => void onRoomDelete(room)} aria-label="공간 삭제">공간 삭제</button></div>;
  if (selection.kind === "wall") {
    const wall = wallSegment(room.layout, selection.wall);
    const wallGaps = gaps.filter((gap) => gap.wall === selection.wall);
    return <div className="inspector-content"><p className="eyebrow">벽</p><h2>{wallLabel(selection.wall)}</h2><p>길이 {wall.length} mm</p><WallElevationView elevation={wallElevation(room.layout, selection.wall)} onSelect={(item) => onSelectElement(room, item)} /><GapEditor room={room} gaps={wallGaps} onRoomGap={onRoomGap} /><p className="inspector-help">하단의 문 또는 창문을 누른 뒤 이 벽을 누르면 배치됩니다.</p></div>;
  }
  if (selection.kind === "door") {
    const door = room.layout.doors.find((item) => item.id === selection.elementId);
    if (!door) return null;
    return <div className="inspector-content"><p className="eyebrow">문</p><h2>문</h2><label>문 폭 (mm)<input data-inspector-element={door.id} type="number" min="1" value={door.width} onChange={(event) => onDoorChange(room, door.id, { width: positiveNumber(event.target.value, door.width) })} aria-label="문 폭 밀리미터" /></label><label>문 높이 (mm)<input type="number" min="1" placeholder={String(nominalHeights.door)} defaultValue={door.height ?? ""} key={`door-height-${door.height ?? "none"}`} onBlur={(event) => onDoorChange(room, door.id, { height: positiveNumber(event.target.value, door.height ?? nominalHeights.door) })} aria-label="문 높이 밀리미터" /></label><fieldset><legend>경첩</legend><div className="choice-row"><button type="button" aria-pressed={door.hinge === "left"} className={door.hinge === "left" ? "selected" : ""} onClick={() => onDoorChange(room, door.id, { hinge: "left" })} aria-label="왼쪽 경첩">왼쪽</button><button type="button" aria-pressed={door.hinge === "right"} className={door.hinge === "right" ? "selected" : ""} onClick={() => onDoorChange(room, door.id, { hinge: "right" })} aria-label="오른쪽 경첩">오른쪽</button></div></fieldset><fieldset><legend>열림</legend><div className="choice-row"><button type="button" aria-pressed={door.opening === "inward"} className={door.opening === "inward" ? "selected" : ""} onClick={() => onDoorChange(room, door.id, { opening: "inward" })} aria-label="안쪽으로 열림">안쪽</button><button type="button" aria-pressed={door.opening === "outward"} className={door.opening === "outward" ? "selected" : ""} onClick={() => onDoorChange(room, door.id, { opening: "outward" })} aria-label="바깥쪽으로 열림">바깥쪽</button></div></fieldset><WallClearanceEditor room={room} element={door} onMove={(side, clearance) => onElementMove(room, door, side, clearance)} /><p className="inspector-help">호(arc)가 실제 문 열림 방향을 나타냅니다. 방향키로 벽을 따라 10mm씩(Shift 100mm) 옮깁니다.</p><button type="button" className="danger-action" onClick={onElementDelete} aria-label="문 삭제">문 삭제</button></div>;
  }
  if (selection.kind === "window") {
    const window = room.layout.windows.find((item) => item.id === selection.elementId);
    if (!window) return null;
    return <div className="inspector-content"><p className="eyebrow">창문</p><h2>창문</h2><label>폭 (mm)<input data-inspector-element={window.id} type="number" min="1" value={window.width} onChange={(event) => onWindowChange(room, window.id, { width: positiveNumber(event.target.value, window.width) })} aria-label="창문 폭 밀리미터" /></label><label>높이 (mm)<input type="number" min="1" value={window.height} onChange={(event) => onWindowChange(room, window.id, { height: positiveNumber(event.target.value, window.height) })} aria-label="창문 높이 밀리미터" /></label><label>바닥 높이 (mm)<input type="number" min="0" value={window.sillHeight} onChange={(event) => onWindowChange(room, window.id, { sillHeight: nonNegativeNumber(event.target.value, window.sillHeight) })} aria-label="창문 바닥 높이 밀리미터" /></label><label>개폐 방식<select value={window.opening} onChange={(event) => onWindowChange(room, window.id, { opening: event.target.value as WindowElement["opening"] })} aria-label="창문 개폐 방식"><option value="sliding">미닫이</option><option value="casement">여닫이</option><option value="fixed">고정</option><option value="other">기타</option></select></label><WallClearanceEditor room={room} element={window} onMove={(side, clearance) => onElementMove(room, window, side, clearance)} /><p className="inspector-help">방향키로 벽을 따라 10mm씩(Shift 100mm) 옮깁니다.</p><button type="button" className="danger-action" onClick={onElementDelete} aria-label="창문 삭제">창문 삭제</button></div>;
  }
  const utility = room.layout.utilities.find((item) => item.id === selection.elementId);
  return utility ? <div className="inspector-content"><p className="eyebrow">설비</p><h2>{utilityLabel(utility)}</h2><label>바닥에서 높이 (mm)<input type="number" min="0" placeholder={String(nominalHeights.utilityFloor)} defaultValue={utility.floorHeight ?? ""} key={`floor-height-${utility.floorHeight ?? "none"}`} onBlur={(event) => onUtilityFloorHeight(room, utility, event.target.value)} aria-label="바닥에서 높이 밀리미터" /></label><UtilityPlacementEditor room={room} utility={utility} onMove={(position) => onUtilityMove(room, utility, position)} onResize={(size) => onUtilityResize(room, utility, size)} /><p className="inspector-help">벽 가까이 놓으면 벽에 붙습니다. 방향키로 10mm씩(Shift 100mm) 옮깁니다.</p><button type="button" className="danger-action" onClick={onElementDelete} aria-label={`${utilityLabel(utility)} 삭제`}>{utilityLabel(utility)} 삭제</button></div> : null;
}

/**
 * The selected wall drawn face-on, so the heights of what is mounted on it are visible at a glance.
 * Heights nobody has measured are drawn dashed and labelled, never as if they were readings.
 */
function WallElevationView({ elevation, onSelect }: {
  elevation: WallElevation;
  onSelect: (item: WallElevationItem) => void;
}) {
  const margin = Math.max(elevation.length, elevation.ceiling) * 0.06;
  const width = elevation.length + margin * 2;
  const height = elevation.ceiling + margin * 2;
  const label = Math.max(width, height) * 0.045;
  // The drawing is metres tall in real units, so flip the y axis to put the floor at the bottom.
  const top = (item: WallElevationItem) => elevation.ceiling - item.bottom - item.height;
  return (
    <figure className="wall-elevation">
      <figcaption>
        벽 입면 · 천장 {elevation.ceiling.toLocaleString()} mm{elevation.ceilingMeasured ? "" : " (미입력)"}
      </figcaption>
      <svg viewBox={`${-margin} ${-margin} ${width} ${height}`} role="img" aria-label={`${wallLabel(elevation.wall)} 입면도`}>
        <rect x="0" y="0" width={elevation.length} height={elevation.ceiling} className={elevation.ceilingMeasured ? "elevation-wall" : "elevation-wall assumed"} />
        {elevation.items.map((item) => <g
          key={item.id}
          className={`elevation-item ${item.kind}${item.measured ? "" : " assumed"}`}
          role="button"
          tabIndex={0}
          aria-label={`${item.label} 바닥에서 ${item.bottom} mm${item.measured ? "" : ", 높이 미입력"}`}
          onClick={() => onSelect(item)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(item); } }}
        >
          <rect x={item.offset} y={top(item)} width={item.width} height={item.height} />
          <text x={item.offset + item.width / 2} y={top(item) + item.height + label * 1.2} style={{ fontSize: label }} textAnchor="middle">{item.bottom.toLocaleString()}</text>
        </g>)}
        <line x1="0" y1={elevation.ceiling} x2={elevation.length} y2={elevation.ceiling} className="elevation-floor" />
      </svg>
      {elevation.items.length === 0 && <p className="inspector-help">이 벽에 배치된 문·창문·설비가 없습니다.</p>}
    </figure>
  );
}

/** Positions a door or window by the run of wall left on each side, the way a tape measures it. */
function WallClearanceEditor({ room, element, onMove }: {
  room: LocalRoom;
  element: DoorElement | WindowElement;
  onMove: (side: "start" | "end", clearance: number) => void;
}) {
  const clearances = wallElementClearances(room.layout, element);
  const neighbours = wallNeighbours(element.wall);
  const sides = [
    { side: "start" as const, wall: neighbours.start, value: clearances.start },
    { side: "end" as const, wall: neighbours.end, value: clearances.end },
  ];
  return <fieldset className="gap-editor">
    <legend>벽에서 거리 (mm)</legend>
    {sides.map(({ side, wall, value }) => <label key={side}>
      <span>{wall ? wallLabel(wall) : side === "start" ? "벽 시작점" : "벽 끝점"}에서</span>
      <input
        type="number"
        min="0"
        defaultValue={value}
        key={`${side}-${value}`}
        onBlur={(event) => onMove(side, nonNegativeNumber(event.target.value, value))}
        aria-label={`${wall ? wallLabel(wall) : side === "start" ? "벽 시작점" : "벽 끝점"}에서 거리 밀리미터`}
      />
    </label>)}
  </fieldset>;
}

/** Positions a utility by its distance to each of the four walls around it. */
function UtilityPlacementEditor({ room, utility, onMove, onResize }: {
  room: LocalRoom;
  utility: UtilityElement;
  onMove: (position: Point) => void;
  onResize: (size: { width: number; height: number }) => void;
}) {
  const bounds = roomRect(room.layout);
  const rect = utilityRect(utility);
  const size = utilitySize(utility);
  const distances = [
    { wall: "west" as Wall, value: Math.round(rect.x - bounds.x) },
    { wall: "north" as Wall, value: Math.round(rect.y - bounds.y) },
    { wall: "east" as Wall, value: Math.round(bounds.x + bounds.width - (rect.x + rect.width)) },
    { wall: "south" as Wall, value: Math.round(bounds.y + bounds.height - (rect.y + rect.height)) },
  ];
  function moveTo(wall: Wall, distance: number) {
    const gap = Math.max(0, distance);
    if (wall === "west") onMove({ x: Math.round(bounds.x + gap + size.width / 2), y: utility.position.y });
    else if (wall === "east") onMove({ x: Math.round(bounds.x + bounds.width - gap - size.width / 2), y: utility.position.y });
    else if (wall === "north") onMove({ x: utility.position.x, y: Math.round(bounds.y + gap + size.height / 2) });
    else onMove({ x: utility.position.x, y: Math.round(bounds.y + bounds.height - gap - size.height / 2) });
  }
  return <>
    <fieldset className="gap-editor">
      <legend>벽에서 거리 (mm)</legend>
      {distances.map(({ wall, value }) => <label key={wall}>
        <span>{wallLabel(wall)}에서</span>
        <input
          type="number"
          min="0"
          defaultValue={value}
          key={`${wall}-${value}`}
          onBlur={(event) => moveTo(wall, nonNegativeNumber(event.target.value, value))}
          aria-label={`${wallLabel(wall)}에서 거리 밀리미터`}
        />
      </label>)}
    </fieldset>
    <fieldset className="gap-editor">
      <legend>크기 (mm)</legend>
      <label>
        <span>가로</span>
        <input type="number" min="1" defaultValue={size.width} key={`utility-width-${size.width}`} onBlur={(event) => onResize({ ...size, width: positiveNumber(event.target.value, size.width) })} aria-label="설비 가로 밀리미터" />
      </label>
      <label>
        <span>세로</span>
        <input type="number" min="1" defaultValue={size.height} key={`utility-height-${size.height}`} onBlur={(event) => onResize({ ...size, height: positiveNumber(event.target.value, size.height) })} aria-label="설비 세로 밀리미터" />
      </label>
    </fieldset>
  </>;
}

/** Cuts one corner out of the room so it reads as an L, with the cut sized in millimetres. */
function NotchEditor({ room, onRoomNotch }: {
  room: LocalRoom;
  onRoomNotch: (room: LocalRoom, notch: RoomNotch | null) => void;
}) {
  const notch = room.layout.notch;
  const size = {
    width: notch?.width ?? Math.round(room.layout.size.width / 3),
    height: notch?.height ?? Math.round(room.layout.size.height / 3),
  };
  return <fieldset className="notch-editor">
    <legend>ㄱ자 모서리</legend>
    <div className="choice-grid">
      {roomCorners.map((corner) => <button
        key={corner}
        type="button"
        aria-pressed={notch?.corner === corner}
        className={notch?.corner === corner ? "selected" : ""}
        aria-label={`${cornerLabel(corner)} 모서리 파내기`}
        onClick={() => onRoomNotch(room, notch?.corner === corner ? null : { corner, ...size })}
      >{cornerLabel(corner)}</button>)}
    </div>
    {notch && <>
      <label><span>파낸 가로 (mm)</span><input type="number" min="1" defaultValue={notch.width} key={`notch-width-${notch.width}`} onBlur={(event) => onRoomNotch(room, { ...notch, width: positiveNumber(event.target.value, notch.width) })} aria-label="파낸 가로 밀리미터" /></label>
      <label><span>파낸 세로 (mm)</span><input type="number" min="1" defaultValue={notch.height} key={`notch-height-${notch.height}`} onBlur={(event) => onRoomNotch(room, { ...notch, height: positiveNumber(event.target.value, notch.height) })} aria-label="파낸 세로 밀리미터" /></label>
      <p className="inspector-help">평면도에서 안쪽 모서리 점을 끌어도 됩니다. 모서리를 되돌리면 안쪽 벽에 붙은 문과 창문도 함께 사라집니다.</p>
    </>}
  </fieldset>;
}

/** Shows how far each wall sits from the room facing it and lets the user type an exact gap. */
function GapEditor({ room, gaps, onRoomGap }: {
  room: LocalRoom;
  gaps: RoomGap[];
  onRoomGap: (room: LocalRoom, gap: RoomGap, distance: number) => void;
}) {
  if (gaps.length === 0) return <p className="inspector-help">맞닿거나 마주 보는 다른 공간이 없어 벽 사이 거리를 표시할 수 없습니다.</p>;
  return <fieldset className="gap-editor">
    <legend>이웃 공간까지 거리 (mm)</legend>
    {gaps.map((gap) => <label key={gap.wall}>
      <span>{wallLabel(gap.wall)} · {gap.neighbor.name}</span>
      <input
        type="number"
        min="0"
        defaultValue={gap.distance}
        key={`${gap.wall}-${gap.neighbor.id}-${gap.distance}`}
        onBlur={(event) => onRoomGap(room, gap, nonNegativeNumber(event.target.value, gap.distance))}
        aria-label={`${wallLabel(gap.wall)} 간격 밀리미터`}
      />
    </label>)}
  </fieldset>;
}

function PropertyEditor({ property, onSave, onDelete }: {
  property: LocalProperty;
  onSave: (property: LocalProperty, update: PropertyUpdate) => Promise<void>;
  onDelete: (property: LocalProperty) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => ({ name: property.name, address: property.address ?? "", note: property.note ?? "" }));

  useEffect(() => setDraft({ name: property.name, address: property.address ?? "", note: property.note ?? "" }), [property]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    await onSave(property, { name, address: draft.address.trim() || null, note: draft.note.trim() || null });
  }

  return <form className="property-editor" onSubmit={(event) => void submit(event)} aria-label="집 정보 편집"><label>집 이름<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-label="집 이름" /></label><label>주소<input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} aria-label="집 주소" /></label><label>메모<textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} aria-label="집 메모" /></label><button type="submit" className="secondary-action">집 정보 저장</button><button type="button" className="danger-action" onClick={() => void onDelete(property)} aria-label="집 삭제">집 삭제</button></form>;
}

function layoutWithDraggedObject(layout: RoomLayout, drag: ObjectDragState, point: Point, tolerance: number): RoomLayout {
  if (drag.kind === "door") {
    return { ...layout, doors: layout.doors.map((door) => door.id === drag.elementId ? moveWallElement(layout, door, point) : door) };
  }
  if (drag.kind === "window") {
    return { ...layout, windows: layout.windows.map((window) => window.id === drag.elementId ? moveWallElement(layout, window, point) : window) };
  }
  return {
    ...layout,
    utilities: layout.utilities.map((utility) => utility.id === drag.elementId
      ? { ...utility, position: clampUtilityPosition(layout, snapUtilityToWall(layout, { ...utility, position: point }, tolerance)) }
      : utility),
  };
}

function reshaped(before: RoomLayout, after: RoomLayout): boolean {
  return before.position.x !== after.position.x || before.position.y !== after.position.y
    || before.size.width !== after.size.width || before.size.height !== after.size.height
    || before.notch?.corner !== after.notch?.corner
    || before.notch?.width !== after.notch?.width
    || before.notch?.height !== after.notch?.height;
}

function neighborRooms(rooms: readonly LocalRoom[], excludedId: ClientId): NeighborRoom[] {
  return rooms.filter((room) => room.id !== excludedId).map((room) => ({ id: room.id, name: room.name, rect: roomRect(room.layout) }));
}

function viewportCentre(viewport: SvgViewport): Point {
  return { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
}

/**
 * A new room starts flush against the current room, sharing a wall the way rooms in a home do.
 * It takes the first free side so it is never hidden under an existing room; the user can still
 * drag it anywhere afterwards, including on top of another room.
 */
function nextRoomLayout(rooms: readonly LocalRoom[], anchor: LocalRoom | undefined): RoomLayout {
  const size = { width: 4_400, height: 3_300 };
  const empty = { version: 1 as const, size, doors: [], windows: [], utilities: [] };
  if (rooms.length === 0) return { ...empty, position: { x: 900, y: 900 } };
  const rects = rooms.map((room) => roomRect(room.layout));
  const base = roomRect((anchor ?? rooms[rooms.length - 1]!).layout);
  const sides: Point[] = [
    { x: base.x + base.width, y: base.y },
    { x: base.x, y: base.y + base.height },
    { x: base.x - size.width, y: base.y },
    { x: base.x, y: base.y - size.height },
  ];
  const free = sides.find((position) => position.x >= 0 && position.y >= 0
    && !rects.some((rect) => rectsOverlap(rect, { ...position, ...size })));
  return {
    ...empty,
    position: free ?? {
      x: Math.max(...rects.map((rect) => rect.x + rect.width)),
      y: Math.min(...rects.map((rect) => rect.y)),
    },
  };
}

function mutationOperation(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, data: Record<string, unknown>) {
  const clientMutationId = newId("mutation");
  return { clientMutationId, method, path, body: { clientMutationId, data } };
}

function newId(prefix: string): ClientId {
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${entropy}` as ClientId;
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function nonNegativeNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function roomTypeLabel(type: RoomType): string {
  return roomTypes.find((item) => item.type === type)?.label ?? "기타";
}

function wallLabel(wall: Wall): string {
  return {
    north: "위쪽 벽",
    east: "오른쪽 벽",
    south: "아래쪽 벽",
    west: "왼쪽 벽",
    notchHorizontal: "안쪽 가로 벽",
    notchVertical: "안쪽 세로 벽",
  }[wall];
}

/** Rough advance width for the label font, enough to decide whether a line of text clears a wall. */
function fitsInside(text: string, fontSize: number, width: number): boolean {
  return text.length * fontSize * 0.55 <= width;
}

function cornerLabel(corner: RoomCorner): string {
  return { northWest: "왼쪽 위", northEast: "오른쪽 위", southEast: "오른쪽 아래", southWest: "왼쪽 아래" }[corner];
}

function placementInstruction(placement: NonNullable<Placement>): string {
  if (placement.kind === "door") return "문을 놓을 벽을 누르세요.";
  if (placement.kind === "window") return "창문을 놓을 벽을 누르세요.";
  return `${utilityTypes.find((item) => item.type === placement.utility)?.label ?? "설비"}를 놓을 공간 내부를 누르세요.`;
}
