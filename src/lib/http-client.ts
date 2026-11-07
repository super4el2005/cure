import axios from "axios";
import type { AxiosError, AxiosRequestConfig } from "axios";

const client = axios.create({ timeout: 90_000 });

export async function apiClient<T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> {
  return (await client.request<T>({ ...config, ...options })).data;
}
export type ErrorType<T> = AxiosError<T>;
