from .class_register import REGISTERED_MODELS

'''
Import all classes in this directory so that classes with
@register_model are registered.
'''

from os.path import basename, dirname, join
from glob import glob
pwd = dirname(__file__)
for x in glob(join(pwd, '*.py')):
    if not basename(x).startswith('__'):
        __import__('backend.' + basename(x)[:-3],
                   globals(), locals())

__all__ = [
    'REGISTERED_MODELS'
]
