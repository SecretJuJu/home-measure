import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { HomeMeasureDatabase, HttpApiClient, LocalFirstRepository } from "../../local";
import type { LocalChecklistItem, LocalProperty, LocalRoom } from "../../local";
import { FloorPlanEditor, type FloorPlanSelection } from "../floor-plan";
import { ChecklistPanel } from "./ChecklistPanel";
import { createChecklistDefaults, newClientId } from "./definitions";
import { MeasurementMode } from "./MeasurementMode";
import { PropertySummary } from "./PropertySummary";
import { HttpPhotoUploadClient, PhotoUploadQueue } from "../photo";

type Surface = "editor" | "measurement" | "summary";

function useLocalState(repository: LocalFirstRepository) {
  return useSyncExternalStore(repository.store.subscribe, repository.store.getState, repository.store.getInitialState);
}

function createChecklistOperation(item: LocalChecklistItem) {
  const clientMutationId = newClientId("mutation");
  return {
    clientMutationId,
    method: "POST" as const,
    path: "/checklist",
    body: {
      clientMutationId,
      data: {
        id: item.id,
        propertyId: item.propertyId,
        roomId: item.roomId,
        elementId: item.elementId,
        label: item.label,
        category: item.category,
        required: item.required,
        status: item.status,
        measurementId: item.measurementId,
        sortOrder: item.sortOrder,
      },
    },
  };
}

/** Owns one repository for canvas, checklist, field mode, and summary so every surface rehydrates the same local data. */
export function HomeMeasureWorkspace() {
  const [repository] = useState(() => new LocalFirstRepository(new HomeMeasureDatabase(), new HttpApiClient()));
  const [photoQueue] = useState(() => new PhotoUploadQueue(repository, new HttpPhotoUploadClient()));
  const state = useLocalState(repository);
  const [selection, setSelection] = useState<FloorPlanSelection>(null);
  const [surface, setSurface] = useState<Surface>("editor");
  const [measurementTarget, setMeasurementTarget] = useState<{ roomId: string; itemId: string } | null>(null);
  const [summaryPropertyId, setSummaryPropertyId] = useState<string | null>(null);
  const defaultsStartedForRoom = useRef(new Set<string>());

  useEffect(() => () => {
    photoQueue.dispose();
    repository.dispose();
  }, [photoQueue, repository]);

  useEffect(() => {
    if (state.hydrated) void photoQueue.process();
  }, [photoQueue, state.hydrated]);

  const selectedProperty = useMemo(
    () => Object.values(state.properties).sort((left, right) => right.updatedAt - left.updatedAt)[0],
    [state.properties],
  );
  const measurementRoom = measurementTarget ? state.rooms[measurementTarget.roomId] : undefined;
  const measurementItem = measurementTarget ? state.checklistItems[measurementTarget.itemId] : undefined;
  const measurementProperty = measurementRoom ? state.properties[measurementRoom.propertyId] : undefined;
  const summaryProperty = summaryPropertyId ? state.properties[summaryPropertyId] : selectedProperty;

  const createDefaults = useCallback(async (room: LocalRoom) => {
    if (defaultsStartedForRoom.current.has(room.id)) return;
    defaultsStartedForRoom.current.add(room.id);
    const defaults = createChecklistDefaults(room);
    try {
      await Promise.all(defaults.map((item) => repository.persistOptimisticChange({
        entityKind: "checklist",
        entity: item,
        operation: createChecklistOperation(item),
      })));
    } catch (error) {
      defaultsStartedForRoom.current.delete(room.id);
      throw error;
    }
  }, [repository]);

  useEffect(() => {
    if (!state.hydrated) return;
    const roomsWithoutChecklist = Object.values(state.rooms).filter((room) => !Object.values(state.checklistItems).some((item) => item.roomId === room.id));
    for (const room of roomsWithoutChecklist) void createDefaults(room);
  }, [createDefaults, state.checklistItems, state.hydrated, state.rooms]);

  function startMeasurement(room: LocalRoom, item: LocalChecklistItem) {
    setMeasurementTarget({ roomId: room.id, itemId: item.id });
    setSurface("measurement");
  }

  if (surface === "measurement" && measurementProperty && measurementRoom && measurementItem) {
    return <MeasurementMode repository={repository} photoQueue={photoQueue} property={measurementProperty as LocalProperty} room={measurementRoom} initialItem={measurementItem} onExit={() => setSurface("editor")} />;
  }
  if (surface === "summary" && summaryProperty) {
    return <PropertySummary repository={repository} property={summaryProperty as LocalProperty} onBack={() => setSurface("editor")} />;
  }

  return <FloorPlanEditor
    repository={repository}
    selection={selection}
    onSelectionChange={setSelection}
    onRoomCreated={createDefaults}
    onOpenSummary={(property) => { setSummaryPropertyId(property.id); setSurface("summary"); }}
    inspectorSupplement={({ property, room, selection: canvasSelection, select }) => <ChecklistPanel
      repository={repository}
      property={property}
      room={room}
      selection={canvasSelection}
      onSelectionChange={select}
      onStartMeasurement={startMeasurement}
      onOpenSummary={() => { setSummaryPropertyId(property.id); setSurface("summary"); }}
    />}
  />;
}
