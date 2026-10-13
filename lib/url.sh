#!/usr/bin/env bash

function update() {
   if [[ -z "${QUTE_FIFO:-}" ]]; then
      echo "$1"
      return
   fi
   echo ":message-info '$1'" >> "${QUTE_FIFO:-}"
}

function clean() {
   local url="$1"
   local clean_url="$url"
   if [[ -z "$url" ]]; then
      read -r url
      clean_url="$url"
   fi
   case "$url" in
      *youtube.com/watch*)clean_url="${url%%&*}";;
   esac

   echo -n "$clean_url"
}

function clean_all() {
   while read -r url; do
      printf '%s\n' "$(clean "$url")"
   done
}