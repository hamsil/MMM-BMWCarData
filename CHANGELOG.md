# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [1.1.0](https://github.com/hamsil/MMM-BMWCarData/releases/tag/v1.1.0) - 2026-10-25 - CARTO API Key

* fix CARTO API key: the tile proxy now forwards the key to CARTO, and it is sent as `?key=…` instead of `?api_key=…`
* CARTO basemaps (default Dark Matter and Positron) now require a free API key, see [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/); without it, tiles only show an "API KEY REQUIRED" watermark
* improve documentation: `tileApiKey` added to the minimal configuration and explained in "Map tile options"

## [1.0.0](https://github.com/hamsil/MMM-BMWCarData/releases/tag/v1.0.0) - 2026-05-19 - Alternative space saving info display

Since the module has been running stable for many days now this is the first official release!

* new option to add icons before values
* new option to disable headers

## [0.9.3](https://github.com/hamsil/MMM-BMWCarData/releases/tag/v0.9.3) - 2026-05-11 - Conditional Topic Display

* display topic values in the info module only if this value or the values of other topics meet given conditions., e.g. display charging power only when charging is active
* minor improvements

## [0.9.2](https://github.com/hamsil/MMM-BMWCarData/releases/tag/v0.9.2) - 2026-05-11 - Fix zig zag tracks and minor improvements

* fix problem with zig zag track
* add coordinate log for debugging
* improve topic value auto-formatting
* enable translations for enum values
* bump modules
* implement developer hints from MagicMirror² 3rd Party Modules
* improve documentation

## [0.9.1](https://github.com/hamsil/MMM-BMWCarData/releases/tag/v0.9.1) - 2026-05-08 - Implement Developer Hints

* add CHANGELOG
* add CODE_OF_CONDUCT
* add Dependabot configuration for npm modules
* add linter configuration 
* fix linter errors
* improve README
    - fix lowercase repository name in clone instruction
    - add update section

## [0.9.0](https://github.com/hamsil/MMM-BMWCarData/releases/tag/v0.9.0) - 2026-05-07 - Initial Release

Initial release.
