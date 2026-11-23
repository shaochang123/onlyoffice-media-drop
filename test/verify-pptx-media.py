#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Check that media on specified slides resolves to byte-identical embedded files."""

import argparse
from hashlib import sha256
from pathlib import Path, PurePosixPath
import posixpath
from xml.etree import ElementTree as ET
from zipfile import ZipFile

PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MEDIA_RELATIONSHIP_TYPES = {"audio", "video", "media"}


def relationships(pptx, part):
    path = PurePosixPath(part)
    rels = path.parent / "_rels" / (path.name + ".rels")
    if str(rels) not in pptx.namelist():
        return {}
    return {element.attrib["Id"]: element.attrib for element in ET.fromstring(pptx.read(str(rels)))}


def resolve(part, target):
    if target.startswith("/"):
        return posixpath.normpath(target).lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(part), target))


def slide_parts(pptx):
    part = "ppt/presentation.xml"
    document = ET.fromstring(pptx.read(part))
    links = relationships(pptx, part)
    return [resolve(part, links[slide.attrib[f"{{{REL_NS}}}id"]]["Target"])
            for slide in document.findall(f".//{{{PRESENTATION_NS}}}sldId")]


def media_hashes(pptx, slide):
    ids = {value for element in ET.fromstring(pptx.read(slide)).iter()
           for key, value in element.attrib.items() if key.startswith(f"{{{REL_NS}}}")}
    hashes = {}
    for key, relationship in relationships(pptx, slide).items():
        kind = relationship["Type"].rsplit("/", 1)[-1]
        if key not in ids or kind not in MEDIA_RELATIONSHIP_TYPES:
            continue
        target = relationship["Target"]
        if relationship.get("TargetMode") == "External":
            raise ValueError(f"{slide} includes an external {kind} relationship to {target}")
        part = resolve(slide, target)
        if not part.startswith("ppt/media/"):
            raise ValueError(f"{slide} links to media outside ppt/media: {part}")
        hashes[sha256(pptx.read(part)).hexdigest()] = part
    return hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("presentation", type=Path)
    parser.add_argument("--expect", action="append", default=[], required=True, metavar="SLIDE=FILE",
                        help="1-based slide number and exact source file to verify (repeatable)")
    args = parser.parse_args()
    with ZipFile(args.presentation) as pptx:
        slides = slide_parts(pptx)
        for spec in args.expect:
            position, delimiter, filename = spec.partition("=")
            if not delimiter or not position.isdecimal() or not 1 <= int(position) <= len(slides):
                parser.error(f"Invalid slide and file: {spec}")
            source = Path(filename)
            digest = sha256(source.read_bytes()).hexdigest()
            matches = media_hashes(pptx, slides[int(position) - 1])
            if digest not in matches:
                raise SystemExit(f"Slide {position} has no embedded copy of {source.name}")
            print(f"Slide {position}: {source.name} -> {matches[digest]} (SHA-256 matches)")


if __name__ == "__main__":
    main()
