"use client";

import { useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WatchlistItem } from "@/lib/watchlists/model";
import type { WatchlistColumn } from "@/lib/watchlists/preferences";
import { WatchlistRow } from "./watchlist-row";

type Props = {
  item: WatchlistItem;
  columns: WatchlistColumn[];
  selected: boolean;
  selectedListId: string;
  watchlists: Array<{ id: string; name: string }>;
  onSelect: () => void;
  onRemove: () => void;
  onNote: (note: string) => void;
  onMove: (watchlistId: string) => void;
  virtualStart?: number;
};

export function SortableWatchlistRow(props: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.item.id });
  const dragHandle = useMemo(() => ({
    ...attributes,
    ...listeners,
    ref: setActivatorNodeRef,
  }), [attributes, listeners, setActivatorNodeRef]);
  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: "relative",
    zIndex: isDragging ? 5 : undefined,
    opacity: isDragging ? 0.6 : undefined,
  };
  return (
    <WatchlistRow
      {...props}
      dragHandle={dragHandle}
      rowRef={setNodeRef}
      rowStyle={rowStyle}
      rowAttributes={attributes}
      virtualStart={props.virtualStart}
    />
  );
}
