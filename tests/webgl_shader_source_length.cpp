#define GL_GLEXT_PROTOTYPES
#include <GLES/gl.h>
#include <GLES/glext.h>
#include <GLES2/gl2.h>
#include <stdio.h>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <assert.h>
#include <string.h>

int result = 0;

#define GL_CALL( x ) \
    { \
        x; \
        GLenum error = glGetError(); \
        if( error != GL_NO_ERROR ) { \
            printf( "GL ERROR: %d,  %s\n", (int)error, #x ); \
            result = 1; \
        } \
    } \


int main()
{
  emscripten_set_canvas_size( 100, 100 );

  EmscriptenWebGLContextAttributes attrs;
  emscripten_webgl_init_context_attributes(&attrs);

  EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = emscripten_webgl_create_context( 0, &attrs );
  if (!context)
  {
    printf("Skipped: WebGL is not supported.\n");
#ifdef REPORT_RESULT
    REPORT_RESULT(result);
#endif
    return 0;
  }
  emscripten_webgl_make_context_current(context);

  GLuint shader;
  GL_CALL( shader = glCreateShader(GL_VERTEX_SHADER) );

  GLint value = -97631;
  GL_CALL( glGetShaderiv(shader, GL_SHADER_SOURCE_LENGTH, &value) );
  assert(value == 0);

  const GLchar* tempSource = (const GLchar*)"";
  GL_CALL( glShaderSource(shader, 1, &tempSource, NULL) );

  value = -97631;
  GL_CALL( glGetShaderiv(shader, GL_SHADER_SOURCE_LENGTH, &value) );
  assert(value == 0);

  tempSource = (const GLchar*)"void main() { gl_Position = vec4(0); }";
  GL_CALL( glShaderSource(shader, 1, &tempSource, NULL) );

  value = -97631;
  GL_CALL( glGetShaderiv(shader, GL_SHADER_SOURCE_LENGTH, &value) );
  assert(value == strlen(tempSource) + 1);

  EMSCRIPTEN_RESULT res = emscripten_webgl_destroy_context(context);
  assert(res == EMSCRIPTEN_RESULT_SUCCESS);

#ifdef REPORT_RESULT
  REPORT_RESULT(result);
#endif
  return 0;
}
