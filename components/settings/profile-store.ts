"use client";

import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { defaultProfile, PROFILE_STORAGE_KEY, profileSchema, readProfile, type UserProfile } from "@/lib/profile";

const profileStore = createStore(() => ({ profile: defaultProfile, loaded: false }));

function hydrate() {
  try { profileStore.setState({ profile: readProfile(localStorage.getItem(PROFILE_STORAGE_KEY)), loaded: true }); }
  catch { profileStore.setState({ loaded: true }); }
}

export function useProfile() {
  const state = useStore(profileStore);
  useEffect(() => {
    if (!profileStore.getState().loaded) hydrate();
    const sync = (event: StorageEvent) => { if (event.key === PROFILE_STORAGE_KEY || event.key === null) hydrate(); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return state;
}

export function saveProfile(profile: UserProfile) {
  const valid = profileSchema.parse(profile);
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(valid));
  profileStore.setState({ profile: valid, loaded: true });
}

export async function prepareAvatar(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("请选择 PNG、JPG、WebP 或 GIF 图片");
  if (file.size > 5 * 1024 * 1024) throw new Error("头像原图不能超过 5 MB");
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error("图片尺寸过大，请选择较小的头像");
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理头像图片");
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/webp", 0.85);
  } finally { bitmap.close(); }
}
