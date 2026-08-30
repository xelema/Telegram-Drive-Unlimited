#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <application-version> <output.cdx.json>" >&2
  exit 2
fi

version="$1"
output_path="$2"
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Application version must be X.Y.Z, received: ${version}" >&2
  exit 1
fi
for command in jq pacman pactree sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

temporary_root="$(mktemp -d)"
trap 'rm -rf "${temporary_root}"' EXIT
resolved_packages="${temporary_root}/resolved-packages.txt"
components="${temporary_root}/components.ndjson"

pactree --unique --linear telegram-drive-bin | LC_ALL=C sort -u > "${resolved_packages}"
while IFS= read -r package_name; do
  [[ -n "${package_name}" ]] || continue
  [[ "${package_name}" != 'telegram-drive-bin' ]] || continue
  read -r resolved_name resolved_version <<<"$(pacman -Q -- "${package_name}")"
  architecture="$(pacman -Qi -- "${package_name}" | awk -F ': ' '/^Architecture/{print $2; exit}')"
  jq -cn \
    --arg name "${resolved_name}" \
    --arg version "${resolved_version}" \
    --arg architecture "${architecture}" \
    '{
      type: "library",
      "bom-ref": ("pkg:alpm/arch/" + ($name | @uri) + "@" + ($version | @uri) + "?arch=" + ($architecture | @uri)),
      name: $name,
      version: $version,
      purl: ("pkg:alpm/arch/" + ($name | @uri) + "@" + ($version | @uri) + "?arch=" + ($architecture | @uri))
    }' >> "${components}"
done < "${resolved_packages}"

resolution_digest="$(sha256sum "${resolved_packages}" | awk '{print $1}')"
serial="urn:uuid:${resolution_digest:0:8}-${resolution_digest:8:4}-5${resolution_digest:13:3}-a${resolution_digest:17:3}-${resolution_digest:20:12}"
mkdir -p "$(dirname "${output_path}")"
jq -s \
  --arg serial "${serial}" \
  --arg version "${version}" \
  '{
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: $serial,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": ("pkg:alpm/arch/telegram-drive-bin@" + $version),
        name: "telegram-drive-bin",
        version: $version
      }
    },
    components: sort_by(."bom-ref")
  }' "${components}" > "${output_path}"

jq -e '.bomFormat == "CycloneDX" and .specVersion == "1.5" and (.components | length > 0)' \
  "${output_path}" >/dev/null
echo "Generated Arch runtime SBOM at ${output_path}"
