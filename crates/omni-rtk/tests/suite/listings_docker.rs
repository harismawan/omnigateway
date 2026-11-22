//! `packages/rtk/test/listings-docker.test.ts`.

use super::common::*;

#[test]
fn compresses_command_gated_tree_output_and_preserves_hierarchy_and_summary() {
    let f = run(
        "tree -F",
        &cat(&[
            strs(&["project", "├── src/"]),
            gen_lines(40, |i| format!("│   ├── descriptive-file-{i}.ts")),
            strs(&["└── link@ -> src", "2 directories, 40 files"]),
        ]),
    );
    assert!(has(&f.report, "tree-output"));
    for a in [
        "project",
        "├── src/",
        "└── link@ -> src",
        "2 directories, 40 files",
    ] {
        assert!(f.content.contains(a), "{a}");
    }
}

#[test]
fn compresses_posix_long_listing_but_fails_open_on_unparsed_locale_rows() {
    let rows = gen_lines(120, |i| {
        format!("-rw-r--r-- 1 u g 10 Aug 10 12:00 file-{i}.ts")
    });
    let valid = run(
        "ls -la",
        &cat(&[
            strs(&["total 120"]),
            rows.clone(),
            strs(&[
                "drwxr-xr-x 2 u g 4096 Aug 10 12:00 dir",
                "lrwxrwxrwx 1 u g 3 Aug 10 12:00 link -> dir",
            ]),
        ]),
    );
    assert!(has(&valid.report, "tree-output"));
    assert!(valid.content.contains("link -> dir"));
    let malformed = run(
        "ls -la",
        &cat(&[
            strs(&["total 120"]),
            rows,
            strs(&["locale-specific row impossible to count"]),
        ]),
    );
    assert!(!has(&malformed.report, "tree-output"));
}

#[test]
fn unknown_path_inference_requires_density_and_rejects_prose_conflicts() {
    let paths = gen_lines(100, |i| format!("./src/file-{i}.ts"));
    assert!(has(
        &run_named("ignored", &paths, "mystery").report,
        "path-list"
    ));
    let prose = cat(&[paths[..8].to_vec(), vec!["This is prose.".to_owned(); 92]]);
    assert!(!has(
        &run_named("ignored", &prose, "mystery").report,
        "path-list"
    ));
}

#[test]
fn compresses_docker_builds_while_preserving_artifacts_and_errors() {
    for command in [
        "docker build .",
        "docker buildx build .",
        "docker compose build",
    ] {
        let anchors = strs(&[
            "#1 [1/3] FROM alpine@sha256:abc",
            "Dockerfile:4",
            "ERROR: process exited with code 1",
            "naming to docker.io/acme/app:latest",
            "digest: sha256:def",
        ]);
        let f = run(
            command,
            &cat(&[
                anchors[..1].to_vec(),
                vec!["#1 1.0 50% transferring".to_owned(); 120],
                anchors[1..].to_vec(),
            ]),
        );
        assert!(has(&f.report, "docker-build"), "{command}");
        for a in &anchors {
            assert!(f.content.contains(a.as_str()), "{command}: {a}");
        }
    }
}

#[test]
fn never_activates_docker_filtering_for_unknown_origin() {
    let f = run_named(
        "docker build .",
        &cat(&[
            strs(&["#1 [1/3] FROM alpine"]),
            gen_lines(120, |i| format!("progress {i}")),
            strs(&["exporting image"]),
        ]),
        "mystery",
    );
    assert!(!has(&f.report, "docker-build"));
}
