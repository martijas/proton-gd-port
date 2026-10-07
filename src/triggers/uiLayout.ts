// UI Trigger (3613): at load, objects in its target group are pinned to the
// screen about a guide. The trigger itself is a settings object; layout is
// what positionUIObjects does once from updateSpecialGroupData.
//
// [gdp UISettingsGameObject::customObjectSetup :309905-309941;
//  GJBaseGameLayer::positionUIObjects :444377-444607]

const REF_HALF_W = 240;
const REF_HALF_H = 160;

export interface UiAnchor {
  objX: number;
  objY: number;
  guideX: number;
  guideY: number;
  xref: number;
  yref: number;
  scaleX: boolean;
  scaleY: boolean;
}

export interface UiTriggerKeys {
  group: number;
  target: number;
  xref: number;
  yref: number;
  scaleX: boolean;
  scaleY: boolean;
}

export function uiKeysOf(props: Record<number, string | undefined>): UiTriggerKeys {
  const n = (k: number): number => Math.trunc(Number(props[k] ?? 0)) || 0;
  const flag = (k: number): boolean => {
    const v = props[k];
    return v !== undefined && Number(v) !== 0;
  };
  return { group: n(51), target: n(71), xref: n(385), yref: n(386), scaleX: flag(387), scaleY: flag(388) };
}

/** Offset from the view centre in camera units. [positionUIObjects :444507-444569] */
export function uiOffsetFromCentre(
  a: UiAnchor,
  viewHalfW: number,
  viewHalfH: number,
): { dx: number; dy: number } {
  let xref = a.xref;
  let yref = a.yref;
  if (xref <= 1) xref = a.objX >= a.guideX ? 4 : 3;
  if (yref === 5 || yref === 0) yref = a.objY >= a.guideY ? 8 : 7;
  const sx = a.scaleX ? viewHalfW / REF_HALF_W : 1;
  const sy = a.scaleY ? viewHalfH / REF_HALF_H : 1;

  let screenX: number;
  switch (xref) {
    case 2:
      screenX = (a.objX - a.guideX) * sx + viewHalfW;
      break;
    case 3: {
      let v = a.objX - (a.guideX - REF_HALF_W);
      if (a.scaleX) v *= sx;
      screenX = v;
      break;
    }
    case 4: {
      let v = a.objX - (a.guideX + REF_HALF_W);
      if (a.scaleX) v *= sx;
      screenX = viewHalfW * 2 + v;
      break;
    }
    default:
      screenX = (a.objX - a.guideX) * sx + viewHalfW;
  }

  let screenY: number;
  switch (yref) {
    case 6:
      screenY = (a.objY - a.guideY) * sy + viewHalfH;
      break;
    case 7: {
      let v = a.objY - (a.guideY - REF_HALF_H);
      if (a.scaleY) v *= sy;
      screenY = v;
      break;
    }
    case 8: {
      let v = a.objY - (a.guideY + REF_HALF_H);
      if (a.scaleY) v *= sy;
      screenY = viewHalfH * 2 + v;
      break;
    }
    default:
      screenY = (a.objY - a.guideY) * sy + viewHalfH;
  }

  return { dx: screenX - viewHalfW, dy: screenY - viewHalfH };
}
