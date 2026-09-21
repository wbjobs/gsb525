const DRAG_THRESHOLD = 6;

export function initPointerDrag(board, onDrop) {
  let pending = null;
  let dragging = null;
  let suppressClick = false;

  function clearDropIndicators() {
    board.querySelectorAll(".drop-indicator").forEach((element) => element.remove());
    board.querySelectorAll(".column.drag-over").forEach((element) => {
      element.classList.remove("drag-over");
    });
  }

  function cleanup() {
    if (dragging) {
      dragging.ghost.remove();
      board.removeAttribute("data-dragging-id");
      board
        .querySelectorAll('.card[data-dragging="true"]')
        .forEach((element) => element.removeAttribute("data-dragging"));
      if (board.hasPointerCapture(dragging.pointerId)) {
        board.releasePointerCapture(dragging.pointerId);
      }
    }
    dragging = null;
    pending = null;
    clearDropIndicators();
  }

  function startDrag(event) {
    const source = event.target.closest(".card");
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true);

    ghost.classList.add("drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);

    board.setPointerCapture(event.pointerId);
    board.dataset.draggingId = pending.cardId;
    source.dataset.dragging = "true";

    dragging = {
      pointerId: event.pointerId,
      cardId: pending.cardId,
      source,
      ghost,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      target: null
    };
  }

  function findDropTarget(event) {
    const columnElement = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest(".column");
    if (!columnElement) return null;

    const list = columnElement.querySelector(".card-list");
    const cards = [...list.querySelectorAll(".card")].filter(
      (card) => card.dataset.cardId !== dragging.cardId
    );

    let targetIndex = cards.length;
    let insertBefore = null;

    for (const [index, card] of cards.entries()) {
      const rect = card.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        targetIndex = index;
        insertBefore = card;
        break;
      }
    }

    return {
      columnId: columnElement.dataset.columnId,
      columnElement,
      list,
      targetIndex,
      insertBefore
    };
  }

  function showIndicator(target) {
    clearDropIndicators();
    target.columnElement.classList.add("drag-over");
    const indicator = document.createElement("div");
    indicator.className = "drop-indicator";

    if (target.insertBefore) {
      target.list.insertBefore(indicator, target.insertBefore);
    } else {
      target.list.appendChild(indicator);
    }
    dragging.target = target;
  }

  board.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest("button, input, textarea, a, dialog")) return;
    const card = event.target.closest(".card");
    if (!card) return;

    pending = {
      cardId: card.dataset.cardId,
      startX: event.clientX,
      startY: event.clientY
    };
  });

  board.addEventListener("pointermove", (event) => {
    if (!pending && !dragging) return;

    if (pending && !dragging) {
      const distanceX = event.clientX - pending.startX;
      const distanceY = event.clientY - pending.startY;
      if (Math.hypot(distanceX, distanceY) < DRAG_THRESHOLD) return;
      startDrag(event);
    }

    dragging.ghost.style.left = `${event.clientX - dragging.offsetX}px`;
    dragging.ghost.style.top = `${event.clientY - dragging.offsetY}px`;

    const target = findDropTarget(event);
    if (target) showIndicator(target);
    else clearDropIndicators();
  });

  board.addEventListener("pointerup", (event) => {
    if (!dragging) {
      pending = null;
      return;
    }

    if (dragging) {
      const target = dragging.target ?? findDropTarget(event);
      const drop = dragging.cardId;
      cleanup();

      if (target) {
        suppressClick = true;
        window.addEventListener("click", stopClick, { capture: true, once: true });
        window.setTimeout(() => {
          suppressClick = false;
        }, 250);
        void onDrop(drop, target.columnId, target.targetIndex);
      }
    }
  });

  board.addEventListener("pointercancel", cleanup);

  window.addEventListener("pointerup", () => {
    if (pending) pending = null;
  }, true);

  window.addEventListener("pointercancel", () => {
    pending = null;
  }, true);

  function stopClick(event) {
    if (!suppressClick) return;
    event.stopPropagation();
    event.preventDefault();
  }

  return {
    isDragging: () => Boolean(dragging),
    getDraggingCardId: () => dragging?.cardId ?? null,
    cancel: cleanup
  };
}
