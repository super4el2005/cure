import axios from "axios";
import type { AxiosError, AxiosRequestConfig } from "axios";

export async function apiClient<T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> {
  return (await axios.request<T>({ ...config, ...options })).data;
}
export type ErrorType<T> = AxiosError<T>;
