/* Linux/glibc test-only preload. Keeps unsafe code out of Rust crates.
 * cc -shared -fPIC -o /tmp/opencode/diag/drain/fix3-alloc.so this-file.c -ldl
 * LD_PRELOAD=... ASSERT_ALLOC_CONSTANT=1 cargo test --offline -p omni-providers
 *   --test body_allocations -- --nocapture
 * Counts only the measured reader thread, after shared-buffer warmup.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t,size_t);
extern void *__libc_realloc(void*,size_t);
static __thread int enabled;
static __thread size_t count;
void *malloc(size_t n) { if(enabled)count++; return __libc_malloc(n); }
void *calloc(size_t a,size_t b) { if(enabled)count++; return __libc_calloc(a,b); }
void *realloc(void *p,size_t n) { if(enabled)count++; return __libc_realloc(p,n); }
int open64(const char *path,int flags,...) {
 if(strstr(path,"/alloc-start")){count=0;enabled=1;return -1;}
 if(strstr(path,"/alloc-stop")){enabled=0;fprintf(stderr,"BODY_ALLOCATIONS=%zu\n",count);if(getenv("ASSERT_ALLOC_CONSTANT") && count>8)_exit(99);return -1;}
 static int (*real_open)(const char*,int,...);
 if(!real_open)real_open=dlsym(RTLD_NEXT,"open64");
 mode_t mode=0;if(flags&O_CREAT){va_list ap;va_start(ap,flags);mode=va_arg(ap,int);va_end(ap);}
 return real_open(path,flags,mode);
}
